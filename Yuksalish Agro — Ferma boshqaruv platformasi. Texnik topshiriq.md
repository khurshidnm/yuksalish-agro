# Yuksalish Agro — Ferma boshqaruv platformasi. Texnik topshiriq

Nov 4, 2026 · @Xurshid

## 1. Hujjat haqida

Ushbu texnik topshiriq (TZ) "Yuksalish Agro" fermer xo'jaligi faoliyatini to'liq raqamlashtiruvchi, keyinchalik boshqa fermalarga ham taqdim etiladigan bulutli SaaS platformani ishlab chiqish uchun tuzildi. Platforma yer, ekin, chorva, ozuqa, moliya, xodimlar, texnika va sotuv bo'yicha barcha hisob-kitobni yagona tizimda yuritadi, AI yordamida tahlil qiladi va keyingi bosqichda kameralar orqali monitoringni ta'minlaydi.

| Band | Mazmuni |
| --- | --- |
| Buyurtmachi | "Yuksalish Agro" fermer xo'jaligi (Buxoro viloyati, Qorovulbozor tumani) |
| Ishlab chiquvchi | Ichki ishlab chiqish jamoasi (keyinchalik aniqlashtiriladi) |
| Platformaning ishchi nomi | Yuksalish Agro Platform (YAP) |
| Mahsulot turi | Ko'p ijarachili (multi-tenant) bulutli SaaS, veb-ilova + mobil ilova |
| Birinchi foydalanuvchi | Yuksalish Agro fermasi (pilot) |
| Maqsadli bozor (keyingi bosqich) | O'zbekistondagi chorvachilik va dehqonchilik fermer xo'jaliklari |
| Interfeys tillari | O'zbek (lotin, kirill), rus, ingliz |
| Hujjat holati | Birinchi tahrir, muhokama uchun |

Hujjat 25 bo'limdan iborat: 1–5 bo'limlar umumiy kontekst va arxitekturani, 6–18 bo'limlar funksional modullarni, 19–22 bo'limlar integratsiya, nofunksional talablar, texnologiya va ma'lumotlar modelini, 23–25 bo'limlar amalga oshirish rejasi, qabul mezonlari va ilovalarni belgilaydi.

## 2. Ferma profili: Yuksalish Agro

Platforma dastlab 210 gektarlik aralash (dehqonchilik va qo'ychilik) xo'jalik misolida yo'lga qo'yiladi. Quyidagi boshlang'ich holat platformaning birinchi ma'lumotlar to'plami sifatida kiritiladi.

| Ko'rsatkich | Qiymati |
| --- | --- |
| Joylashuv | Buxoro viloyati, Qorovulbozor tumani |
| Umumiy yer maydoni | 210 ga |
| Ekin maydoni | 70 ga |
| Qolgan maydon (140 ga) | Yaylov, infratuzilma, molxona, zaxira hududlar (aniqlashtiriladi) |
| Joriy mavsum ekinlari (noyabr 2026) | Bug'doy, sholi, beda yoki arpa (dalalar bo'yicha taqsimot platformada belgilanadi) |
| Chorva (2026 yil) | 500 bosh Hisori zotli bo'g'oz sovliq |
| Molxona sig'imi | 1 000 boshgacha, yopiq turdagi |
| Rejalashtirilgan video-monitoring | Molxona, ozuqa ombori, dala kirish nuqtalari (keyingi bosqich) |
| Buxgalteriya | Platforma ichida boshlang'ich hisob; keyinchalik Keeping bilan integratsiya |

### 2.1. Yuksalish Agro uchun birinchi yil asosiy jarayonlari

1. Kuzgi ekish (noyabr 2026): 70 ga maydonni dalalarga bo'lish, har bir dalaga ekin biriktirish, urug', o'g'it, suv va mexanizatsiya xarajatlarini hisobga olish.
2. Qo'y sotib olish (2026 yil oxiri): 500 bosh sovliqni biriktirilgan raqam (birka) bilan ro'yxatga olish, bo'g'ozlik muddatini qayd etish.
3. Qishlov (dekabr–mart): kunlik ozuqa sarfi, suv, veterinariya tadbirlari, molxona holati.
4. Qo'zilash (2027 yil bahori): har bir sovliqdan tug'ilgan qo'zilarni ro'yxatga olish, nobudgarchilik va o'sish hisobi.
5. Hosil yig'ish (iyun–oktyabr 2027): dalalar bo'yicha hosildorlik, o'z ehtiyoji va sotuvga ajratish, beda va somonni ozuqa omboriga kirim qilish.
6. Sotuv (2027 yil): qo'zilar, jun, ortiqcha don va beda sotuvi, tannarx va rentabellik tahlili.

### 2.2. Fermaning platformadan kutayotgan natijalari

- Har bir so'm xarajat va daromad qaysi dalaga, qaysi qo'yga yoki qaysi jarayonga tegishli ekani aniq ko'rinadi.
- Har bir qo'yning sog'lig'i, vazni, nasli va rentabelligi bo'yicha to'liq tarix yuritiladi.
- Har bir dalaning tannarxi, hosildorligi va foydasi mavsum bo'yicha taqqoslanadi.
- Kutilayotgan daromad va xarajatlar prognozi oldindan ko'rinib turadi.
- Ferma rahbari va investorlar uchun real vaqtda ko'rsatkichlar paneli ishlaydi.
- AI kunlik ma'lumotlarni tahlil qilib, og'ishlar va tavsiyalarni avtomatik bildiradi.

## 3. Atamalar va qisqartmalar

| Atama | Izohi |
| --- | --- |
| Tenant (ijarachi) | Platformadagi bitta mustaqil xo'jalik; uning ma'lumotlari boshqa xo'jaliklardan to'liq ajratilgan |
| Ferma | Tenant ichidagi bitta ishlab chiqarish obyekti (bitta tenant bir nechta fermaga ega bo'lishi mumkin) |
| Dala (kontur) | Chegaralari xaritada belgilangan ekin maydoni birligi |
| Poda (guruh) | Bir xil sharoitda saqlanadigan hayvonlar guruhi (masalan, bo'g'oz sovliqlar, qo'zilar, qo'chqorlar) |
| Birka (tag) | Hayvonning noyob identifikatori: quloq raqami, RFID chip yoki QR-kod |
| Xarajat markazi | Xarajat va daromad biriktiriladigan obyekt: dala, poda, hayvon, texnika, xodim, umumiy ferma |
| Tannarx | Mahsulot birligiga (1 kg go'sht, 1 t bug'doy, 1 bosh qo'zi) sarflangan barcha xarajatlar yig'indisi |
| Agrotexnik tadbir | Dalada bajariladigan ish: haydash, ekish, sug'orish, o'g'itlash, yig'ish |
| Veterinariya tadbiri | Emlash, davolash, profilaktika, tekshiruv |
| Ozuqa ratsioni | Bir hayvon yoki podaga kunlik beriladigan ozuqa tarkibi va miqdori |
| Dashboard | Asosiy ko'rsatkichlar jamlangan boshqaruv paneli |
| KPI | Asosiy samaradorlik ko'rsatkichi |
| RBAC | Rolga asoslangan kirish huquqlari tizimi |
| API | Tashqi tizimlar bilan ma'lumot almashish interfeysi |
| NVR / VMS | Video-yozuvlarni saqlovchi qurilma / video boshqaruv tizimi |
| RTSP / ONVIF | IP-kameralar bilan ishlashning ochiq standartlari |
| LLM | Katta til modeli (AI-tahlil va suhbat yordamchisi uchun) |
| MVP | Minimal ishlaydigan mahsulot, birinchi bosqich natijasi |

## 4. Platformaning umumiy konsepsiyasi va arxitekturasi

Platforma bitta kod bazasida ishlaydigan, har bir xo'jalik uchun alohida ma'lumotlar maydoni ajratilgan, modullarga bo'lingan bulutli tizim sifatida quriladi. Yuksalish Agro birinchi tenant bo'ladi; keyingi fermalar yangi tenant sifatida ulanadi va ularga kerakli modullar faollashtiriladi.

### 4.1. Asosiy tamoyillar

1. Universal ma'lumotlar modeli: hayvon turi, ekin turi, o'lchov birligi, valyuta, hisob-kitob davri kabi barcha parametrlar ma'lumotnomalar orqali sozlanadi, kodga bog'lanmaydi.
2. Modullilik: har bir modul (chorva, o'simlikchilik, moliya, kamera va h.k.) alohida yoqiladi yoki o'chiriladi; tarif rejasi modul to'plamiga qarab belgilanadi.
3. Multi-tenant ajratish: barcha jadvallarda `tenant_id` majburiy; so'rovlar darajasida ma'lumotlar izolyatsiyasi; bitta xo'jalik boshqa xo'jalik ma'lumotlarini hech qachon ko'ra olmaydi.
4. Yagona hodisalar jurnali: har bir amal (ozuqa berildi, emlandi, sotildi, to'landi) sanali hodisa sifatida yoziladi; hisobotlar va AI-tahlil shu jurnaldan hosil bo'ladi.
5. Xarajat markazlari orqali hisob: har bir xarajat va daromad dala, poda, hayvon, texnika yoki umumiy ferma bilan bog'lanadi; tannarx avtomatik hisoblanadi.
6. Mobil birinchi: dala va molxonadagi ma'lumotlar telefon orqali, oflayn rejimda ham kiritiladi va keyin sinxronlanadi.
7. API-birinchi: barcha funksiyalar REST/GraphQL API orqali ochiq; kameralar, datchiklar, buxgalteriya va bank tizimlari shu API orqali ulanadi.
8. AI qatlami alohida: AI xizmati asosiy ma'lumotlar bazasidan faqat o'qiydi, tahlil va tavsiyalarni alohida jadvalda saqlaydi; AI hech qachon moliyaviy yozuvni o'zi o'zgartirmaydi.

### 4.2. Tizim qatlamlari

&#91;embedded content: tizim arxitekturasi · 3 mijoz, API-shlyuz, 12 modul, AI qatlami, 3 ma'lumot ombori\]

Mijoz ilovalari faqat API-shlyuz orqali ishlaydi; modullar va AI qatlami bitta bazaga tayanadi, lekin AI faqat o'qiydi. Tashqi tizimlar API orqali, ferma qurilmalari esa hodisalar API orqali ulanadi.

### 4.3. Tenant va ferma ierarxiyasi

| Daraja | Misol (Yuksalish Agro) | Izoh |
| --- | --- | --- |
| Platforma | Yuksalish Agro Platform | Barcha tenantlar, tariflar, global ma'lumotnomalar |
| Tenant | "Yuksalish Agro" MChJ / FX | Yuridik shaxs, hisob-kitob valyutasi, soliq rejimi |
| Ferma | Qorovulbozor fermasi | Geografik obyekt, 210 ga |
| Bo'linma | Dehqonchilik, qo'ychilik, mexanizatsiya | Xarajat markazlari guruhi |
| Obyekt | Dala №1 (12 ga, bug'doy), Molxona №1, Poda "Bo'g'oz sovliqlar" | Hisob-kitobning eng kichik birligi |

## 5. Foydalanuvchi rollari va huquqlar

Kirish huquqlari rolga asoslangan (RBAC) tizim orqali boshqariladi. Har bir tenant o'z rollarini standart to'plam asosida sozlaydi; huquqlar modul va amal darajasida (ko'rish, yaratish, tahrirlash, tasdiqlash, o'chirish) belgilanadi.

| Rol | Kim | Asosiy huquqlar |
| --- | --- | --- |
| Platforma administratori | Ishlab chiquvchi jamoa | Tenantlar, tariflar, global ma'lumotnomalar, tizim monitoringi; tenant ichidagi biznes ma'lumotlariga kirmaydi |
| Egasi (Owner) | Ferma egasi, ta'sischi | Barcha modullar, moliyaviy tasdiqlash, foydalanuvchilarni boshqarish, hisobotlar, AI-tahlil |
| Direktor / boshqaruvchi | Ferma rahbari | Barcha operatsion modullar, byudjet, xarajatlarni tasdiqlash, dashboard |
| Buxgalter / moliyachi | Hisobchi | Moliya, ish haqi, kontragentlar, hisobotlar; chorva va dala ma'lumotlarini faqat ko'radi |
| Agronom | Dehqonchilik mas'uli | O'simlikchilik moduli to'liq, ozuqa ombori (kirim), texnika buyurtmasi |
| Zootexnik | Chorvachilik mas'uli | Chorvachilik moduli to'liq, ozuqa ratsioni, vazn va nasl hisobi |
| Veterinar | Veterinariya shifokori | Hayvonlar sog'lig'i, emlash, davolash, dori-darmon ombori |
| Omborchi | Ombor mas'uli | Ozuqa, dori, ehtiyot qismlar, yoqilg'i kirim-chiqimi |
| Brigadir / mexanizator | Dala va texnika xodimi | O'ziga biriktirilgan vazifalarni bajarish, ish hajmini kiritish, texnika yurish hisobi |
| Cho'pon / parvarishchi | Molxona xodimi | Mobil ilova orqali kunlik ozuqa, suv, kuzatuv, nobudgarchilik qaydlari |
| Investor / nazoratchi | Tashqi tomon | Faqat o'qish: dashboard, hisobotlar; shaxsiy ma'lumotlar yashiriladi |
| Auditor | Tekshiruvchi | Faqat o'qish: moliya va hodisalar jurnali, o'zgarishlar tarixi |

### 5.1. Huquqlarga oid qo'shimcha talablar

- Moliyaviy amallar (to'lov, ish haqi, sotuv) ikki bosqichli: kirituvchi va tasdiqlovchi turli shaxslar bo'ladi (sozlanadi).
- Har bir yozuvda kim, qachon va qaysi qurilmadan kiritgani saqlanadi.
- Mobil ilovada rolga qarab faqat kerakli ekranlar ko'rsatiladi.
- Foydalanuvchi bir vaqtning o'zida bir nechta fermaga turli rollar bilan ulanishi mumkin.
- Xodim ishdan ketganda uning hisobi bloklanadi, kiritgan ma'lumotlari saqlanib qoladi.

## 6. Modul: Ferma pasporti va yer resurslari

Modul fermaning barcha yer va qurilish obyektlarini xaritaga bog'langan holda ro'yxatga oladi. Yuksalish Agro uchun 210 ga maydon dalalar, yaylov, molxona va infratuzilma konturlariga bo'linadi.

### 6.1. Funksional talablar

| № | Talab | Tavsif |
| --- | --- | --- |
| 6.1.1 | Ferma pasporti | Nomi, yuridik rekvizitlar, manzil, umumiy maydon, yer huquqi hujjatlari (ijara shartnomasi, kadastr raqami), mas'ul shaxslar |
| 6.1.2 | Interaktiv xarita | Dalalar va obyektlar chegarasini xaritada chizish (GeoJSON), sun'iy yo'ldosh qatlami, maydon avtomatik hisoblanadi |
| 6.1.3 | Dala kartochkasi | Raqami, maydoni (ga), tuproq turi, sho'rlanish darajasi, sug'orish manbai, joriy ekin, oldingi 5 yil ekinlari |
| 6.1.4 | Obyektlar reyestri | Molxona (sig'imi 1 000 bosh), ozuqa ombori, suv inshootlari, quduq, elektr, yo'llar, to'siqlar |
| 6.1.5 | Sug'orish tarmog'i | Kanal, ariq, nasos, quvur va ularning dalalarga bog'lanishi; suv limiti va haqiqiy sarf |
| 6.1.6 | Hujjatlar arxivi | Yer, qurilish, ruxsatnoma, shartnoma skanlari; muddati tugaydigan hujjatlar bo'yicha eslatma |
| 6.1.7 | Almashlab ekish tarixi | Har bir dala bo'yicha yillar kesimida ekin, hosildorlik, tannarx |
| 6.1.8 | Tuproq tahlili | Laboratoriya natijalarini (NPK, pH, gumus, sho'rlanish) sana bilan saqlash va dinamikasini ko'rish |

### 6.2. Yuksalish Agro boshlang'ich konturlari

| Kontur turi | Maydon (ga) | Izoh |
| --- | --- | --- |
| Ekin dalalari | 70 | Bug'doy, sholi, beda, arpa bo'yicha dalalarga bo'linadi |
| Yaylov va zaxira | aniqlashtiriladi | 140 ga ichida |
| Molxona va hovli | aniqlashtiriladi | Yopiq molxona, 1 000 bosh |
| Ozuqa ombori | aniqlashtiriladi | Beda, somon, don, silos |
| Infratuzilma | aniqlashtiriladi | Yo'llar, suv, elektr, qorovulxona |

> Ochiq savol: 140 ga qoldiq maydonning aniq taqsimoti (yaylov, lalmi, qurilish) belgilanishi kerak.

## 7. Modul: O'simlikchilik

Modul ekin rejalashtirishdan hosilni omborga kirim qilishgacha bo'lgan butun jarayonni dala kesimida yuritadi. Har bir dala alohida xarajat markazi bo'lib, undagi barcha xarajatlar mavsum yakunida tannarx va rentabellikka aylanadi.

### 7.1. Ekin rejalashtirish

- Mavsum (kuzgi 2026/27, yozgi 2027) va dala bo'yicha ekin tanlash: bug'doy, sholi, beda, arpa va boshqa ekinlar ma'lumotnomadan.
- Har bir ekin uchun texnologik karta: agrotexnik tadbirlar ketma-ketligi, muddatlari, me'yorlari (urug' kg/ga, o'g'it kg/ga, suv m³/ga, ishchi kuni).
- Reja bo'yicha xarajat smetasi va kutilayotgan hosil (t/ga) avtomatik hisoblanadi.
- Beda va arpa uchun ozuqa moduli bilan bog'lanish: rejalashtirilgan hosilning qancha qismi o'z chorvasiga, qanchasi sotuvga ketishi.

### 7.2. Agrotexnik tadbirlar jurnali

| Tadbir | Kiritiladigan ma'lumot |
| --- | --- |
| Yer tayyorlash (haydash, tekislash, mola) | Sana, dala, texnika, mexanizator, yoqilg'i sarfi, ish hajmi (ga) |
| Ekish | Sana, dala, urug' navi va partiyasi, me'yor (kg/ga), haqiqiy sarf, texnika |
| Sug'orish | Sana, dala, suv manbai, miqdori (m³), davomiyligi, mas'ul |
| O'g'itlash | Sana, dala, o'g'it turi, me'yor va haqiqiy sarf, narxi |
| Himoya (gerbitsid, insektitsid) | Sana, dala, preparat, dozasi, kutish muddati |
| Kuzatuv | Sana, dala, o'simlik holati, zararkunanda va kasallik belgilari, foto |
| Hosil yig'ish | Sana, dala, yalpi hosil (t), namlik, texnika, sifat |
| Ombor kirimi | Hosil ozuqa yoki mahsulot omboriga partiya sifatida kiradi |

### 7.3. Hisob-kitob va tahlil

- Dala bo'yicha haqiqiy xarajat va reja farqi (urug', o'g'it, suv, yoqilg'i, mehnat, texnika amortizatsiyasi).
- Hosildorlik (t/ga) va 1 tonna mahsulot tannarxi.
- Mahsulotni sotish yoki o'z chorvasiga ozuqa sifatida berish bo'yicha ichki narx (transfer narx) bilan hisob.
- Mavsumlar va dalalar o'rtasida taqqoslash; almashlab ekish tavsiyalari AI moduliga uzatiladi.
- Ob-havo ma'lumotlari (harorat, yog'ingarchilik, sovuq) tadbirlar jurnaliga avtomatik biriktiriladi.

### 7.4. Mobil ilovadagi ishlar

- Agronom va brigadir dalada turib tadbirni, foto va GPS-nuqtani kiritadi.
- Mexanizator smena hisobotini (bajarilgan gektar, yoqilg'i, nosozlik) yuboradi.
- Ochiq vazifalar ro'yxati va muddati o'tgan tadbirlar eslatmasi.

## 8. Modul: Chorvachilik (qo'ychilik)

Modul har bir hayvonni tug'ilganidan (yoki sotib olinganidan) sotilgunicha yoki chiqib ketgunicha individual kuzatadi. Yuksalish Agro uchun 500 bosh Hisori bo'g'oz sovliq birinchi poda bo'ladi; qo'zilash, o'sish, nasl va tannarx shu modulda hisoblanadi. Hayvon turi ma'lumotnomada sozlanadi, shuning uchun modul qoramol, echki, ot va parranda uchun ham ishlaydi.

### 8.1. Hayvonlar reyestri

| Maydon | Tavsif |
| --- | --- |
| Identifikator | Quloq birkasi raqami, RFID (ISO 11784/11785), QR-kod; bir hayvonga bir nechta identifikator |
| Zoti va turi | Hisori, Jaydari, Qorako'l, Edilbay va h.k.; zot ma'lumotnomasi |
| Jinsi va toifasi | Sovliq, qo'chqor, qo'zi (erkak/urg'ochi), bichilgan, boquvdagi |
| Tug'ilgan sana / yoshi | Aniq sana yoki taxminiy yosh |
| Kelib chiqishi | Tug'ilgan (ona va ota birkasi) yoki sotib olingan (sotuvchi, sana, narx, hujjat) |
| Poda va joylashuv | Qaysi poda, qaysi molxona bo'limi yoki yaylov |
| Holati | Faol, bo'g'oz, kasal, karantin, sotilgan, so'yilgan, nobud bo'lgan, yo'qolgan |
| Vazn tarixi | Sana va vazn (kg); kunlik o'sish avtomatik hisoblanadi |
| Foto | Hayvon rasmi, vaqti-vaqti bilan yangilanadi |
| Tannarx | Sotib olish narxi + biriktirilgan xarajatlar (ozuqa, veterinariya, mehnat) |

### 8.2. Ko'payish va nasl hisobi

- Bo'g'ozlik qaydi: qochirish yoki sotib olishdagi bo'g'ozlik sanasi, kutilayotgan qo'zilash sanasi (qo'y uchun 145–152 kun), qo'chqor identifikatori.
- Qo'zilash qaydi: sana, qo'zilar soni (1, 2, 3), har bir qo'zining jinsi va tug'ilgandagi vazni, tug'ruq asoratlari.
- Nobudgarchilik: qo'zi yoki sovliq o'limi sanasi, sababi, veterinar xulosasi, foto.
- Nasl daraxti: hayvonning ota-onasi va avlodlari; qarindosh qochirishdan ogohlantirish.
- Naslchilik ko'rsatkichlari: sovliq bo'yicha tug'ilgan qo'zilar soni, saqlanib qolish foizi, qo'zilarning 100 kunlik vazni.
- Qo'chqor reytingi: avlodlarining o'sish ko'rsatkichlari bo'yicha avtomatik baho.

### 8.3. Sog'liq va veterinariya

| Funksiya | Tavsif |
| --- | --- |
| Emlash kalendari | Zot va yosh bo'yicha majburiy emlashlar (brutsellyoz, chechak, oqsil, enterotoksemiya va boshqalar); muddati yaqinlashganda eslatma |
| Davolash jurnali | Tashxis, preparat, dozasi, kurs, veterinar, natija; dori ombordan avtomatik chiqim qilinadi |
| Karantin | Yangi kelgan va kasal hayvonlar uchun karantin muddati va holati |
| Gijja va parazitlarga qarshi ishlov | Rejalashtirilgan va bajarilgan ishlovlar |
| Kutish muddati | Preparatdan keyin go'sht yoki sutni sotish mumkin bo'lgan sana avtomatik hisoblanadi |
| Davlat hujjatlari | Veterinariya guvohnomasi, karantin sertifikati, davlat reyestriga topshiriladigan hisobotlar |

### 8.4. Poda boshqaruvi va kunlik operatsiyalar

- Podalarni shakllantirish va hayvonlarni podadan podaga ko'chirish (masalan, qo'zilashdan keyin alohida guruh).
- Kunlik qayd (mobil ilova): har bir poda bo'yicha ozuqa va suv berildi, holat normal yoki og'ish bor, foto.
- Vazn o'lchash kampaniyasi: belgilangan kunda butun podani tortish, natijani RFID o'quvchi orqali avtomatik kiritish.
- Junqirqish: sana, hayvon, jun vazni va sifati; jun mahsulot omboriga kirim qilinadi.
- Yaylovga chiqarish va qaytarish jurnali; yaylov yuklamasi (bosh/ga).

### 8.5. Chiqim operatsiyalari

- Sotuv: tirik vazn, kg narxi, xaridor, hujjat; sotilgan hayvon reyestrda arxivlanadi.
- So'yish: tirik va so'yilgan vazn, go'sht chiqishi (%), go'sht mahsulot omboriga kiradi.
- Nobud bo'lish va yo'qolish: sabab, akt, moliyaviy zarar hisobga olinadi.

### 8.6. Hisob-kitob ko'rsatkichlari

| Ko'rsatkich | Hisoblash |
| --- | --- |
| Poda soni | Boshlang'ich + tug'ilgan + sotib olingan − sotilgan − so'yilgan − nobud bo'lgan |
| Qo'zilash foizi | Tug'ilgan qo'zilar / qochirilgan sovliqlar × 100 |
| Saqlanib qolish | Tirik qo'zilar (sutdan ajratishda) / tug'ilgan qo'zilar × 100 |
| O'rtacha kunlik o'sish | (Oxirgi vazn − oldingi vazn) / kunlar soni |
| 1 kg tirik vazn tannarxi | Podaga biriktirilgan barcha xarajatlar / qo'shilgan tirik vazn |
| Ozuqa konversiyasi | Sarflangan ozuqa (kg quruq modda) / qo'shilgan vazn (kg) |
| Bir sovliqdan daromad | (Qo'zi sotuvi + jun) / sovliqlar soni |

### 8.7. Aqlli qurilmalar bilan integratsiya (keyingi bosqich)

- RFID o'quvchi va elektron tarozi: hayvonni skanerlash bilan vazn avtomatik yoziladi.
- Aqlli bo'yinbog' yoki quloq datchigi: harakat, harorat, kuyikish va kasallik belgilarini aniqlash.
- Avtomatik suv va ozuqa hisoblagichlari: poda bo'yicha haqiqiy sarf.

## 9. Modul: Ozuqa va ombor

Modul barcha moddiy zaxiralarni partiyalar kesimida yuritadi: ozuqa, urug', o'g'it, dori-darmon, yoqilg'i, ehtiyot qismlar va tayyor mahsulot. Har bir chiqim xarajat markaziga (poda, dala, texnika) biriktiriladi; shu orqali tannarx avtomatik shakllanadi.

### 9.1. Omborlar va nomenklatura

| Ombor turi | Nomenklatura misollari | O'lchov birligi |
| --- | --- | --- |
| Ozuqa ombori | Beda (pichan), somon, arpa, bug'doy, kepak, kunjara, silos, tuz, mineral qo'shimchalar | kg, t, bog' |
| Urug' va o'g'it | Bug'doy, arpa, beda, sholi urug'i; azotli, fosforli, kaliyli o'g'itlar | kg, t |
| Veterinariya ombori | Vaksinalar, antibiotiklar, vitaminlar, dezinfeksiya vositalari | doza, flakon, litr |
| Yoqilg'i va moylash | Dizel, benzin, moy | litr |
| Ehtiyot qismlar va inventar | Texnika qismlari, asboblar, to'siq materiallari | dona |
| Tayyor mahsulot | Tirik qo'y, go'sht, jun, don, beda (sotuvga) | bosh, kg, t |

### 9.2. Funksional talablar

- Kirim: xarid (kontragent, hisob-faktura, narx), o'z hosilidan (dala va partiya), qaytarish.
- Chiqim: ratsion bo'yicha podaga, agrotexnik tadbir bo'yicha dalaga, texnikaga yoqilg'i, sotuv.
- Partiyalar bo'yicha hisob: har bir kirim alohida partiya, o'rtacha yoki FIFO tannarx (sozlanadi).
- Minimal qoldiq va eslatma: ozuqa qoldig'i belgilangan kunlik zaxiradan kamaysa ogohlantirish.
- Inventarizatsiya: haqiqiy qoldiqni kiritish, farqni akt bilan rasmiylashtirish.
- Yaroqlilik muddati: dori va urug' partiyalari bo'yicha muddat nazorati.
- Ombor hujjatlari: kirim orderi, chiqim talabnomasi, ko'chirish, inventarizatsiya akti (PDF).

### 9.3. Ozuqa ratsioni

- Poda va fiziologik holat (bo'g'oz, emizikli, qo'zi, boquv) bo'yicha ratsion shabloni: har bir ozuqa turi kg/bosh/kun.
- Kunlik ozuqa sarfi ratsion × poda soni bo'yicha avtomatik rejalashtiriladi; haqiqiy sarf mobil ilovadan kiritiladi.
- Ozuqa balansi: mavjud zaxira necha kunga yetadi; qish mavsumi uchun yetishmaydigan hajm va xarid rejasi.
- Ratsion tannarxi: 1 bosh uchun kunlik va mavsumiy ozuqa xarajati.
- Yuksalish Agro uchun birinchi hisob: 500 sovliq × qishlov kunlari × ratsion me'yori asosida ozuqa ehtiyoji va shu asosda beda/arpa ekin maydonini asoslash.

## 10. Modul: Moliya va hisob-kitob

Modul fermaning boshqaruv hisobini yuritadi: har bir xarajat va daromad sanasi, summasi, to'lov usuli va xarajat markazi bilan qayd etiladi; byudjet, pul oqimi prognozi, tannarx va rentabellik shu asosda hisoblanadi. Rasmiy buxgalteriya va soliq hisoboti Keeping platformasi bilan integratsiya orqali yuritiladi (19-bo'lim).

### 10.1. Xarajatlar moddalari

| Guruh | Moddalar |
| --- | --- |
| Chorva | Hayvon xaridi, ozuqa, veterinariya, birka va qurilmalar, junqirqish |
| Dehqonchilik | Urug', o'g'it, himoya vositalari, suv haqi, mexanizatsiya xizmati |
| Mehnat | Ish haqi, ustamalar, soliqlar, ovqatlanish, kiyim |
| Texnika va uskunalar | Yoqilg'i, ta'mirlash, ehtiyot qismlar, amortizatsiya, ijara |
| Infratuzilma | Elektr, gaz, suv, qurilish va ta'mirlash, qorovul |
| Ma'muriy | Aloqa, transport, hujjatlar, litsenziyalar, bank xizmati |
| Moliyaviy | Kredit foizlari, sug'urta, lizing to'lovlari |
| Investitsion | Molxona qurilishi, texnika xaridi, kamera tizimi |

### 10.2. Daromad manbalari

- Qo'zilar va voyaga yetgan qo'ylar sotuvi (tirik vazn yoki bosh).
- Go'sht va jun sotuvi.
- Don (bug'doy, arpa, sholi) va beda sotuvi.
- Naslchilik mahsuloti (nasldor qo'chqor va sovliq) sotuvi.
- Davlat subsidiyalari, kompensatsiyalar, grantlar.
- Boshqa daromadlar (xizmat ko'rsatish, ijara).

### 10.3. Funksional talablar

| № | Funksiya | Tavsif |
| --- | --- | --- |
| 10.3.1 | Operatsiyalar jurnali | Har bir xarajat/daromad: sana, modda, summa, valyuta, to'lov usuli (naqd, bank, qarz), kontragent, xarajat markazi, hujjat skani |
| 10.3.2 | Kassa va bank | Naqd kassa, bank hisoblari, ular orasidagi o'tkazmalar, kunlik qoldiq |
| 10.3.3 | Qarzdorlik | Kontragentlar bo'yicha debitor va kreditor qarz, to'lov muddati, eslatma |
| 10.3.4 | Byudjet | Yillik va mavsumiy byudjet modda va xarajat markazi bo'yicha; reja/fakt farqi real vaqtda |
| 10.3.5 | Pul oqimi prognozi | Kutilayotgan daromad (qo'zilash, hosil, sotuv rejasi) va majburiy xarajatlar asosida 12 oylik prognoz |
| 10.3.6 | Tannarx hisoblash | Bevosita xarajatlar + umumiy xarajatlarning taqsimoti (sozlanadigan koeffitsiyentlar: bosh soni, maydon, ish soati) |
| 10.3.7 | Rentabellik | Poda, dala, mahsulot turi va butun ferma bo'yicha foyda va rentabellik (%) |
| 10.3.8 | Kredit va lizing | Kredit grafigi, foizlar, asosiy qarz, imtiyozli kredit shartlari, to'lov eslatmalari |
| 10.3.9 | Asosiy vositalar | Molxona, texnika, uskunalar: boshlang'ich qiymat, amortizatsiya usuli va muddati |
| 10.3.10 | Tasdiqlash oqimi | Belgilangan summadan yuqori xarajat rahbar tasdig'ini talab qiladi |
| 10.3.11 | Valyuta | Asosiy valyuta so'm; import xaridlar uchun USD/RUB kursi bilan qayta hisoblash |
| 10.3.12 | Eksport | Excel, PDF, Keeping formatiga eksport |

### 10.4. Asosiy moliyaviy hisobotlar

- Xarajat va daromadlar hisoboti (oy, chorak, mavsum, yil).
- Pul oqimi hisoboti (fakt va prognoz).
- Tannarx hisoboti: 1 bosh qo'zi, 1 kg tirik vazn, 1 t bug'doy, 1 t beda.
- Rentabellik hisoboti: xarajat markazlari bo'yicha.
- Qarzdorlik va kredit hisoboti.
- Byudjet ijrosi hisoboti.
- Investorlar uchun qisqartirilgan hisobot.

## 11. Modul: Xodimlar va ish haqi

Modul xodimlar reyestrini, ish vaqti hisobini, ish haqi hisob-kitobini va bajarilgan ishlar bo'yicha mehnat xarajatini xarajat markazlariga taqsimlashni ta'minlaydi.

| № | Funksiya | Tavsif |
| --- | --- | --- |
| 11.1 | Xodimlar reyestri | Shaxsiy ma'lumotlar, lavozim, bo'linma, ishga qabul sanasi, shartnoma, hujjatlar skani |
| 11.2 | Ish haqi turlari | Oylik, kunlik, ishbay (gektar, bosh, tonna bo'yicha), mavsumiy, ustama va mukofot |
| 11.3 | Tabel | Kunlik kelish/ketish, mobil ilovadan belgilash (GPS bilan), dam olish kunlari, kasallik |
| 11.4 | Bajarilgan ishlar | Agrotexnik va chorva tadbirlaridan avtomatik yig'iladi: kim qancha gektar haydadi, nechta qo'yga ishlov berdi |
| 11.5 | Ish haqi hisob-kitobi | Oylik hisob varag'i, avanslar, ushlab qolishlar, soliq va ijtimoiy to'lovlar (Keeping orqali rasmiy hisob) |
| 11.6 | Mehnat xarajati taqsimoti | Xodimning oylik xarajati bajarilgan ishlar bo'yicha dala va podalarga taqsimlanadi |
| 11.7 | KPI va mukofot | Cho'pon uchun saqlanib qolish foizi, mexanizator uchun bajarilgan gektar; mukofot avtomatik hisoblanadi |
| 11.8 | Xavfsizlik va yo'riqnoma | Mehnat muhofazasi yo'riqnomalari, imzolangan sana, muddati |
| 11.9 | Eslatmalar | Shartnoma muddati, tibbiy ko'rik, mehnat ta'tili |

## 12. Modul: Texnika, uskunalar va aktivlar

Modul fermaning barcha texnika va uskunalarini ro'yxatga oladi, ularning ish vaqti, yoqilg'i sarfi, ta'mirlash xarajatlari va amortizatsiyasini hisoblab, bir soat yoki bir gektar ish tannarxini chiqaradi.

| № | Funksiya | Tavsif |
| --- | --- | --- |
| 12.1 | Aktivlar reyestri | Traktor, kombayn, seyalka, plug, nasos, generator, tarozi, kameralar; inventar raqami, xarid sanasi va narxi, holati |
| 12.2 | Ish jurnali | Har bir smena: sana, texnika, mexanizator, dala yoki ish turi, moto-soat, bajarilgan hajm, yoqilg'i |
| 12.3 | Yoqilg'i hisobi | Yoqilg'i ombori bilan bog'lanish, me'yoriy va haqiqiy sarf, og'ish ogohlantirishi |
| 12.4 | Texnik xizmat | Rejali xizmat (moto-soat yoki sana bo'yicha), ta'mirlash tarixi, ehtiyot qismlar sarfi |
| 12.5 | Amortizatsiya | Chiziqli yoki ish hajmi bo'yicha; oylik summa moliya moduliga avtomatik o'tadi |
| 12.6 | Ijara texnika | Tashqi xizmat (kombayn ijarasi): shartnoma, hajm, narx, akt |
| 12.7 | Ish tannarxi | 1 moto-soat va 1 ga ish tannarxi: yoqilg'i + mehnat + ta'mirlash + amortizatsiya |
| 12.8 | GPS-monitoring (keyingi bosqich) | Treker orqali texnika joylashuvi, yurgan masofa, haqiqiy ishlangan maydon |

## 13. Modul: Sotuv, xaridlar va kontragentlar

Modul fermaning barcha tashqi tomonlar bilan munosabatini yuritadi: xaridorlar, yetkazib beruvchilar, xizmat ko'rsatuvchilar, davlat organlari. Har bir sotuv va xarid ombor hamda moliya modullari bilan avtomatik bog'lanadi.

### 13.1. Kontragentlar

- Kartochka: nomi, STIR, bank rekvizitlari, aloqa shaxslari, toifasi (xaridor, yetkazib beruvchi, bank, davlat organi).
- Shartnomalar: muddat, summa, to'lov shartlari, skan; muddati tugayotgan shartnomalar eslatmasi.
- Hisob-kitob holati: kontragent bo'yicha barcha hujjatlar, to'lovlar va qoldiq qarz.

### 13.2. Sotuv

- Buyurtma: mahsulot (qo'y, go'sht, jun, don, beda), miqdor, narx, xaridor, yetkazib berish sanasi.
- Narxlar ro'yxati va narx tarixi; bozor narxini qo'lda yoki tashqi manbadan kiritish.
- Hujjatlar: shartnoma, hisob-faktura (Keeping/Didox orqali elektron), yuk xati, veterinariya guvohnomasi.
- Sotuv tahlili: mahsulot, xaridor, oy bo'yicha hajm va o'rtacha narx; tannarx bilan taqqoslash.

### 13.3. Xaridlar

- Xarid so'rovi: omborchi yoki zootexnik so'rov yaratadi, rahbar tasdiqlaydi, moliya to'laydi.
- Yetkazib beruvchilarni taqqoslash: bitta nomenklatura bo'yicha narx tarixi.
- Qabul qilish: haqiqiy miqdor va sifat, farq akti, ombor kirimi.

### 13.4. Davlat va subsidiya

- Imtiyozli kredit, subsidiya, kompensatsiya bo'yicha arizalar va ularning holati.
- Davlat organlariga topshiriladigan hisobotlar kalendari (veterinariya, statistika, soliq).

## 14. Dashboard, hisobotlar va KPI

Dashboard fermaning joriy holatini bitta ekranda ko'rsatadi va rolga qarab moslashadi: egasi moliyaviy ko'rsatkichlarni, zootexnik poda holatini, agronom dalalar holatini birinchi ko'radi. Barcha ko'rsatkichlar hodisalar jurnalidan real vaqtda hisoblanadi.

### 14.1. Asosiy dashboard bloklari

| Blok | Ko'rsatkichlar |
| --- | --- |
| Moliya | Oy boshidan xarajat va daromad, kassa va bank qoldig'i, qarzdorlik, byudjet ijrosi (%), 3 oylik pul oqimi prognozi |
| Chorva | Poda soni toifalar bo'yicha, bo'g'oz sovliqlar, kutilayotgan qo'zilash (kun bo'yicha), kasal va karantindagi hayvonlar, oxirgi 30 kun nobudgarchilik, o'rtacha vazn dinamikasi |
| Dehqonchilik | Dalalar holati (ekilgan, sug'orilgan, yig'ilgan), muddati o'tgan tadbirlar, ob-havo prognozi, hosil rejasi/fakt |
| Ozuqa | Zaxira necha kunga yetadi (ozuqa turlari bo'yicha), kunlik sarf, minimal qoldiqdan past pozitsiyalar |
| Xodimlar va texnika | Bugun ishda, bajarilgan vazifalar, texnika holati, yoqilg'i sarfi |
| Ogohlantirishlar | AI va qoidalar asosidagi barcha og'ishlar bir ro'yxatda (muhimlik darajasi bilan) |
| Kamera | Molxona va ombor kameralaridan jonli tasvir va oxirgi hodisalar (16-bo'lim) |

### 14.2. Hisobotlar tizimi

- Standart hisobotlar: har bir modul uchun kamida 5 ta tayyor hisobot (jami 40 dan ortiq), davr va filtr bilan.
- Hisobot konstruktori: foydalanuvchi ustunlar, filtrlar va guruhlashni o'zi tanlaydi, saqlaydi va jadval bo'yicha avtomatik yuboradi.
- Eksport: Excel, PDF, CSV; Telegram va emailga avtomatik yuborish (kunlik, haftalik, oylik).
- Taqqoslash: davrlar, dalalar, podalar, mavsumlar o'rtasida.
- Investor hisoboti: bir sahifali PDF, oylik, avtomatik shakllanadi.

### 14.3. Asosiy KPI ro'yxati

| Yo'nalish | KPI |
| --- | --- |
| Moliya | Rentabellik (%), 1 bosh sovliqqa foyda, operatsion xarajat / daromad, pul oqimi, byudjet og'ishi |
| Chorva | Qo'zilash foizi, saqlanib qolish (%), o'rtacha kunlik o'sish (g), 1 kg tirik vazn tannarxi, ozuqa konversiyasi, nobudgarchilik (%) |
| Dehqonchilik | Hosildorlik (t/ga), 1 t mahsulot tannarxi, tadbirlarni o'z vaqtida bajarish (%), suv sarfi (m³/t) |
| Ozuqa | Zaxira kunlari, 1 bosh kunlik ozuqa xarajati, ozuqa yo'qotishlari (%) |
| Xodimlar | Mehnat unumdorligi (bosh/xodim, ga/xodim), tabel intizomi |
| Texnika | Texnika yuklanishi (%), 1 ga ish tannarxi, rejadan tashqari to'xtashlar |

## 15. AI-tahlil moduli

AI moduli platformadagi barcha ma'lumotlarni (hodisalar jurnali, moliya, ob-havo, kamera hodisalari) tahlil qilib, og'ishlarni aniqlaydi, prognoz beradi va tavsiya tayyorlaydi. AI hech qanday yozuvni o'zi o'zgartirmaydi; har bir tavsiya mas'ul xodim tomonidan qabul qilinadi yoki rad etiladi, bu qaror ham saqlanadi.

### 15.1. AI funksiyalari

| № | Funksiya | Tavsif | Ma'lumot manbai |
| --- | --- | --- | --- |
| 15.1.1 | Suhbat yordamchisi | O'zbek, rus va ingliz tilida savol-javob: "O'tgan oyda ozuqaga qancha sarfladik?", "Qaysi sovliqlar bu hafta qo'zilaydi?"; javob jadval va grafik bilan | Barcha modullar (faqat o'qish) |
| 15.1.2 | Og'ishlarni aniqlash | Ozuqa sarfi, nobudgarchilik, vazn o'sishi, yoqilg'i, xarajatlar bo'yicha me'yordan chetlanishni avtomatik topish | Hodisalar jurnali |
| 15.1.3 | Moliyaviy prognoz | 3, 6, 12 oylik pul oqimi, xarajat va daromad prognozi; pul yetishmaydigan oylarni oldindan ko'rsatish | Moliya, sotuv rejasi, qo'zilash kalendari |
| 15.1.4 | Chorva prognozi | Qo'zilash sanalari va soni, kutilayotgan vazn, sotuvga tayyor bo'lish sanasi, poda o'sishi 1–3 yilga | Chorva reyestri |
| 15.1.5 | Ozuqa balansi tavsiyasi | Qish uchun ozuqa yetishmasligi, xarid vaqti va hajmi, ratsionni arzonlashtirish variantlari | Ozuqa ombori, ratsion, narxlar |
| 15.1.6 | Ekin tavsiyasi | Dala tarixi, tuproq, ob-havo, bozor narxi va ozuqa ehtiyoji asosida keyingi mavsum uchun ekin varianti va kutilayotgan foyda | O'simlikchilik, moliya, ob-havo |
| 15.1.7 | Sog'liq signallari | Vazn pasayishi, ozuqa iste'molining kamayishi, kamera orqali kam harakat kabi belgilardan kasallik ehtimolini aniqlash | Chorva, kamera, datchiklar |
| 15.1.8 | Hujjatlarni o'qish | Hisob-faktura, chek, veterinariya guvohnomasi fotosidan ma'lumotlarni avtomatik ajratib, tasdiqlash uchun taklif qilish | Foto, PDF |
| 15.1.9 | Haftalik va oylik xulosa | Rahbar uchun oddiy tilda yozilgan qisqa hisobot: nima yaxshi, nima yomon, nima qilish kerak | Barcha modullar |
| 15.1.10 | Narx monitoringi (keyingi bosqich) | Qo'y, go'sht, bug'doy, beda bozor narxlari dinamikasi va sotuv vaqti bo'yicha tavsiya | Tashqi manbalar |

### 15.2. Texnik talablar

- AI xizmati alohida mikroservis; asosiy bazaga faqat o'qish huquqi bilan ulanadi.
- LLM provayderi almashtiriladigan (Claude, OpenAI, mahalliy model); tenant ma'lumotlari modelni o'qitishga berilmaydi.
- Prognoz va og'ish modellari uchun avval oddiy statistik usullar (harakatlanuvchi o'rtacha, mavsumiylik), ma'lumot to'plangach ML modellari.
- Har bir AI xulosasida manba ma'lumotlar va ishonch darajasi ko'rsatiladi.
- Tavsiyalar jurnali: tavsiya, sana, qabul qilindi yoki rad etildi, natija; keyinchalik modelni baholash uchun.
- Ma'lumot yetarli bo'lmaganda AI buni ochiq aytadi va taxmin qilmaydi.

### 15.3. Yuksalish Agro uchun birinchi AI stsenariylari

1. 500 sovliqning qo'zilash kalendari va kutilayotgan qo'zilar soni bo'yicha bahorgi ozuqa va mehnat yuklamasi prognozi.
2. Qishlov davomida kunlik ozuqa sarfi me'yordan chetlansa, ertalabki ogohlantirish.
3. 70 ga dala bo'yicha reja/fakt xarajatlar va kutilayotgan hosil asosida mavsum foydasi prognozi.
4. Oylik rahbar xulosasi Telegram orqali.

## 16. Video-monitoring va kamera integratsiyasi

Modul fermaga o'rnatiladigan IP-kameralarni platformaga ulaydi, jonli tasvir va yozuvlarni ko'rsatadi, kompyuter ko'rish (computer vision) modellari yordamida hodisalarni avtomatik aniqlaydi va ularni chorva hamda xavfsizlik ma'lumotlari bilan bog'laydi. Modul ikkinchi bosqichda ishga tushiriladi, lekin ma'lumotlar modeli va API birinchi bosqichdayoq tayyorlanadi.

### 16.1. Kamera infratuzilmasi talablari

| Talab | Tavsif |
| --- | --- |
| Standart | ONVIF Profile S/T va RTSP qo'llab-quvvatlovchi IP-kameralar; brendga bog'lanmaslik |
| Yozuv | Fermada lokal NVR (kamida 30 kun arxiv); muhim hodisa kliplari bulutga yuboriladi |
| Tarmoq | Molxona, ombor va darvoza kameralari uchun PoE-kommutator; internet uzilganda lokal yozuv davom etadi |
| Tasvir sifati | Kamida 2 MP, tungi rejim (IR), molxona uchun 4–6 ta, ombor uchun 2 ta, kirish uchun 2 ta (boshlang'ich reja) |
| Xavfsizlik | Kamera parollari, VPN yoki shifrlangan tunnel orqali bulutga ulanish |

### 16.2. Platformadagi funksiyalar

- Kameralar reyestri: nomi, joylashuvi (xaritada), bog'langan obyekt (molxona bo'limi, ombor), holati (onlayn/oflayn).
- Jonli ko'rish: veb va mobil ilovada mozaika rejimi, rolga qarab kirish.
- Arxiv: sana va vaqt bo'yicha qidirish, hodisa bo'yicha qidirish, klip saqlash va ulashish.
- Hodisalar jurnali: har bir aniqlangan hodisa sana, kamera, foto-kadr, muhimlik darajasi bilan; hodisalar dashboard va bildirishnomalarga chiqadi.
- Kamera holati monitoringi: oflayn bo'lganda ogohlantirish.

### 16.3. AI-tahlil stsenariylari (video)

| Stsenariy | Tavsif | Bosqich |
| --- | --- | --- |
| Hayvonlarni sanash | Molxona bo'limidagi qo'ylar sonini vaqti-vaqti bilan sanash va reyestr bilan solishtirish | 2 |
| Harakatsizlik va ajralib qolish | Uzoq vaqt yotgan yoki podadan ajralgan hayvonni aniqlash, veterinarga signal | 2 |
| Qo'zilash belgilari | Tungi vaqtda qo'zilash faolligini aniqlash va cho'ponga xabar | 3 |
| Ozuqa oxuri holati | Oxur bo'sh qolganini aniqlash | 2 |
| Odam va transport | Ish vaqtidan tashqari harakat, notanish transport, darvoza ochilishi | 2 |
| Xodimlar faoliyati | Ozuqa berish va tozalash ishlari bajarilgan vaqtni tasdiqlash (tabel bilan solishtirish) | 3 |
| Yong'in va tutun | Molxona va omborda tutun belgilarini aniqlash | 2 |

### 16.4. Texnik yondashuv

- Video oqimi fermada edge-qurilmada (NVR yoki mini-server) qayta ishlanadi; bulutga faqat hodisa va kliplar yuboriladi, bu internet trafikini kamaytiradi.
- Hodisalar standart JSON formatida platformaning hodisalar API ga yuboriladi.
- Kompyuter ko'rish modellari fermaning o'z tasvirlarida qo'shimcha o'qitiladi; aniqlik darajasi oylik baholanadi.
- Boshqa datchiklar (harorat, namlik, ammiak, suv sathi) ham shu hodisalar API orqali ulanadi.

## 17. Bildirishnomalar, kalendar va vazifalar

Modul fermaning barcha rejalashtirilgan ishlarini yagona kalendarda jamlaydi, xodimlarga vazifa biriktiradi va muhim hodisalar haqida o'z vaqtida xabar beradi.

### 17.1. Kalendar

- Avtomatik hodisalar: kutilayotgan qo'zilash sanalari, emlash muddatlari, agrotexnik tadbirlar, kredit to'lovlari, shartnoma va hujjat muddatlari, texnik xizmat.
- Qo'lda qo'shiladigan hodisalar: uchrashuv, tekshiruv, yetkazib berish.
- Ko'rinish: kun, hafta, oy; bo'linma va mas'ul bo'yicha filtr.

### 17.2. Vazifalar

- Vazifa: nomi, tavsifi, mas'ul, muddat, bog'langan obyekt (dala, poda, texnika), muhimlik.
- Bajarilganda foto yoki ma'lumot kiritish talab qilinishi mumkin (masalan, emlash vazifasi veterinariya jurnaliga yozuv bilan yopiladi).
- Takrorlanuvchi vazifalar: har kuni ozuqa berish, har hafta molxona tozalash.
- Vazifalar bajarilishi xodimlar KPI siga o'tadi.

### 17.3. Bildirishnomalar

| Kanal | Qo'llanilishi |
| --- | --- |
| Platforma ichida | Barcha bildirishnomalar, o'qilgan/o'qilmagan holati |
| Mobil push | Shoshilinch: kasal hayvon, kamera hodisasi, ozuqa tugayapti |
| Telegram | Kunlik xulosa, ogohlantirishlar, hisobotlar; Telegram-bot orqali tezkor so'rovlar |
| SMS | Internet bo'lmaganda muhim ogohlantirishlar (sozlanadi) |
| Email | Haftalik va oylik hisobotlar, investor hisoboti |

- Har bir foydalanuvchi qaysi hodisani qaysi kanaldan olishini o'zi sozlaydi.
- Muhimlik darajalari: ma'lumot, e'tibor, shoshilinch; shoshilinch ogohlantirish tasdiqlanmaguncha takrorlanadi.

## 18. Mobil ilova va oflayn rejim

Mobil ilova (Android va iOS) dala va molxonada ishlaydigan xodimlarning asosiy vositasi bo'ladi. Qorovulbozordagi fermada internet barqaror bo'lmasligi hisobga olinib, ilova to'liq oflayn rejimda ishlaydi va aloqa tiklanganda ma'lumotlarni sinxronlaydi.

### 18.1. Asosiy ekranlar (rolga qarab)

| Rol | Ekranlar |
| --- | --- |
| Cho'pon / parvarishchi | Bugungi vazifalar, poda bo'yicha kunlik qayd, hayvonni skanerlash (QR/RFID), kasallik xabari (foto bilan), nobudgarchilik qaydi |
| Zootexnik | Hayvon kartochkasi, vazn kiritish, qo'zilash qaydi, poda ko'chirish, ratsion |
| Veterinar | Emlash kalendari, davolash qaydi, dori chiqimi |
| Agronom / brigadir | Dala xaritasi, tadbir qaydi (GPS, foto), vazifalar |
| Mexanizator | Smena hisoboti, yoqilg'i, nosozlik xabari |
| Omborchi | Kirim/chiqim, qoldiq, shtrix-kod skaner |
| Rahbar | Dashboard, ogohlantirishlar, tasdiqlash, kamera jonli tasvir, AI yordamchi |

### 18.2. Texnik talablar

- Oflayn rejim: barcha kiritish shakllari lokal bazada saqlanadi; sinxronizatsiyada ziddiyatlar "oxirgi o'zgarish" va qo'lda tasdiqlash qoidasi bilan hal qilinadi.
- Skanerlash: QR-kod va shtrix-kod kamera orqali, RFID tashqi Bluetooth o'quvchi orqali.
- Foto siqish va GPS-belgi: har bir qaydga avtomatik.
- Ovozli kiritish: o'zbek va rus tilida qisqa qaydlar (keyingi bosqich).
- Katta tugmalar, qo'lqop bilan ishlash, kam yorug'likda o'qiladigan interfeys.
- Android 9+ va iOS 15+; eski arzon qurilmalarda ishlash sinovdan o'tkaziladi.

## 19. Tashqi integratsiyalar

Platforma ochiq API orqali tashqi tizimlar bilan ma'lumot almashadi. Birinchi bosqichda Keeping, ob-havo va Telegram integratsiyasi, keyingi bosqichlarda bank, elektron hisob-faktura, kamera va datchiklar ulanadi.

| Tizim | Maqsad | Yo'nalish | Bosqich |
| --- | --- | --- | --- |
| Keeping (keeping.uz) | Rasmiy buxgalteriya, soliq hisoboti, ish haqi; platformadagi operatsiyalar Keeping ga buxgalteriya provodkalari sifatida uzatiladi | Platforma → Keeping, kontragentlar ikki tomonlama | 1 |
| Didox / elektron hisob-faktura | Sotuv va xarid hujjatlarini elektron rasmiylashtirish | Ikki tomonlama | 2 |
| Ob-havo xizmati | Qorovulbozor uchun kunlik prognoz va tarixiy ma'lumotlar; tadbirlar jurnaliga avtomatik yoziladi | Tashqi → Platforma | 1 |
| Telegram Bot API | Bildirishnomalar, hisobotlar, tezkor so'rovlar, AI yordamchi | Ikki tomonlama | 1 |
| Bank API | Hisob ko'chirmalari avtomatik import, to'lovlarni moslashtirish | Bank → Platforma | 2 |
| SMS-shlyuz | Shoshilinch ogohlantirishlar | Platforma → SMS | 2 |
| Kamera va NVR (ONVIF/RTSP) | Jonli tasvir, arxiv, hodisalar | Ikki tomonlama | 2 |
| IoT datchiklar (MQTT) | Harorat, namlik, suv, tarozi, RFID | Tashqi → Platforma | 2–3 |
| GPS-trekerlar | Texnika monitoringi | Tashqi → Platforma | 3 |
| Davlat tizimlari (veterinariya, statistika) | Majburiy hisobotlarni eksport qilish; API mavjud bo'lsa to'g'ridan-to'g'ri | Platforma → Davlat | 3 |
| Bozor narxlari manbalari | Qo'y, go'sht, don narxlari | Tashqi → Platforma | 3 |
| Google Sheets / Excel | Ma'lumotlarni import va eksport qilish | Ikki tomonlama | 1 |

### 19.1. API talablari

- REST API (JSON), OpenAPI 3.x spetsifikatsiyasi, versiyalash (/api/v1).
- Autentifikatsiya: OAuth 2.0 / API-kalitlar, tenant va rol darajasida cheklov.
- Webhook: platformadagi hodisalar (sotuv, qo'zilash, ogohlantirish) tashqi tizimlarga yuboriladi.
- Hodisalar API: kamera, datchik va boshqa qurilmalar uchun yagona kirish nuqtasi.
- Barcha integratsiyalar uchun xatolar jurnali va qayta urinish mexanizmi.

## 20. Nofunksional talablar

### 20.1. Xavfsizlik

- Ma'lumotlar uzatishda TLS 1.2+, saqlashda shifrlash (bazaviy va zaxira nusxalar).
- Parollar hash ko'rinishida; ikki bosqichli autentifikatsiya (SMS yoki ilova) rahbar va buxgalter rollari uchun majburiy.
- Tenantlar o'rtasida ma'lumotlar izolyatsiyasi so'rov va baza darajasida (row-level security).
- Barcha o'zgarishlar audit jurnalida: kim, qachon, nima, oldingi va yangi qiymat.
- Shaxsiy ma'lumotlar O'zbekiston Respublikasining "Shaxsga doir ma'lumotlar to'g'risida"gi qonuniga muvofiq O'zbekiston hududidagi serverlarda saqlanadi.
- Muntazam xavfsizlik tekshiruvi va zaifliklarni skanerlash.

### 20.2. Ishlash va masshtab

| Ko'rsatkich | Talab |
| --- | --- |
| Sahifa yuklanishi | 2 soniyadan kam (asosiy ekranlar), 4 soniyadan kam (katta hisobotlar) |
| Bir vaqtda foydalanuvchilar | Bitta tenant uchun 100 tagacha, platforma uchun 10 000 tagacha (gorizontal masshtab) |
| Ma'lumot hajmi | Tenant uchun 100 000 hayvon, 10 000 dala, 10 mln hodisa yozuvigacha unumdorlik pasaymasdan |
| Mobil sinxronizatsiya | 1 000 yozuvni 30 soniyada |
| Mavjudlik | 99,5 % (yiliga 44 soatdan ko'p bo'lmagan to'xtash) |
| Kamera oqimi | Tenant uchun 32 tagacha kamera jonli ko'rishda |

### 20.3. Ishonchlilik va zaxira

- Avtomatik zaxira nusxa: baza har 6 soatda, fayllar kuniga bir marta; 90 kun saqlanadi.
- Tiklash vaqti (RTO) 4 soatdan, yo'qotish oynasi (RPO) 6 soatdan oshmaydi.
- Tenant o'z ma'lumotlarini istalgan vaqtda to'liq eksport qila oladi (Excel, CSV, JSON).
- Tizim holati monitoringi va avtomatik ogohlantirish (uptime, xatolar, resurslar).

### 20.4. Lokalizatsiya va qulaylik

- Interfeys: o'zbek (lotin, kirill), rus, ingliz; tillar lug'at fayllari orqali kengaytiriladi.
- Valyuta, sana, o'lchov birliklari tenant darajasida sozlanadi.
- Veb-ilova zamonaviy brauzerlarda, mobil ilova Android va iOS da ishlaydi.
- Interfeys qishloq sharoitidagi foydalanuvchi uchun sodda: minimal menyu, aniq tugmalar, yordam matnlari o'zbek tilida.

### 20.5. Hujjatlashtirish va qo'llab-quvvatlash

- Foydalanuvchi qo'llanmasi (video va matn) har bir rol uchun.
- API hujjati (OpenAPI) va integratsiya qo'llanmasi.
- Ichki yordam markazi va Telegram orqali qo'llab-quvvatlash.

## 21. Texnologik stek va infratuzilma

Stek tavsiya sifatida keltirilgan; ishlab chiquvchi jamoa tajribasiga qarab ekvivalent texnologiyalar tanlanishi mumkin. Asosiy shart: ochiq standartlar, multi-tenant qo'llab-quvvatlash va O'zbekiston hududidagi serverlarda joylashtirish imkoni.

| Qatlam | Tavsiya | Izoh |
| --- | --- | --- |
| Veb-ilova (frontend) | React yoki Vue, TypeScript | Komponentlar kutubxonasi, ko'p tillilik, xarita (Leaflet/MapLibre), grafiklar |
| Mobil ilova | Flutter yoki React Native | Bitta kod bazasi Android va iOS uchun, oflayn lokal baza (SQLite) |
| Backend | Node.js (NestJS) yoki Python (Django/FastAPI) | Modulli arxitektura, REST API, fon vazifalari (navbat) |
| Ma'lumotlar bazasi | PostgreSQL + PostGIS | Multi-tenant, geografik ma'lumotlar (dalalar), JSONB |
| Kesh va navbat | Redis | Sessiyalar, bildirishnomalar navbati, hisoblangan ko'rsatkichlar |
| Fayllar | S3-mos obyekt saqlash (MinIO) | Foto, hujjat skanlari, video kliplar |
| AI qatlami | Alohida Python mikroservis; LLM API (Claude yoki muqobil), pandas/scikit-learn prognoz uchun | Bazaga faqat o'qish huquqi |
| Video-tahlil | Edge-qurilma (NVIDIA Jetson yoki x86 mini-server) + YOLO-oilasi modellari; Frigate yoki shunga o'xshash ochiq NVR | Hodisalar JSON orqali platformaga |
| IoT | MQTT-broker (Mosquitto/EMQX) | Datchiklar va RFID o'quvchilar |
| Infratuzilma | Docker, Kubernetes yoki Docker Compose; O'zbekistondagi bulut provayder yoki o'z serverlari | Avtomatik joylashtirish (CI/CD), monitoring (Prometheus, Grafana) |
| Xavfsizlik | Keycloak yoki o'z autentifikatsiya xizmati, OAuth 2.0, 2FA | Rol va tenant boshqaruvi |

### 21.1. Pilot bosqich uchun infratuzilma (Yuksalish Agro)

- Bulut: 1 ta ilova serveri (8 vCPU, 16 GB RAM), 1 ta baza serveri (4 vCPU, 16 GB RAM, 500 GB SSD), obyekt saqlash 1 TB.
- Ferma: internet (kamida 20 Mbit/s, zaxira sifatida mobil 4G), PoE-kommutator, NVR yoki edge-server, Wi-Fi molxona va omborda.
- Qurilmalar: xodimlar uchun 5–8 ta Android smartfon, 1 ta Bluetooth RFID o'quvchi, elektron tarozi (keyingi bosqich).

## 22. Ma'lumotlar modeli: asosiy obyektlar

Barcha obyektlar `tenant_id`, `farm_id`, `created_by`, `created_at`, `updated_at` maydonlariga ega. Quyida asosiy obyektlar va ular orasidagi bog'lanishlar keltirilgan; to'liq ERD ishlab chiqish bosqichida alohida hujjat sifatida tayyorlanadi.

| Obyekt | Asosiy maydonlar | Bog'lanishlar |
| --- | --- | --- |
| Tenant | nomi, yuridik rekvizitlar, valyuta, tarif, modullar | → Farm, User |
| Farm | nomi, manzil, umumiy maydon, koordinatalar | → Field, Facility, Herd, Warehouse |
| User / Role | ism, telefon, rol, huquqlar | → Tenant, Farm |
| Field (dala) | raqami, maydoni, geometriya (PostGIS), tuproq, sug'orish manbai | → Season, FieldOperation, CostCenter |
| Season / CropPlan | mavsum, dala, ekin, nav, reja xarajat, reja hosil | → Field, Crop |
| FieldOperation | turi, sana, dala, texnika, xodim, materiallar, hajm | → Field, Asset, Employee, StockMovement |
| Harvest | dala, sana, hajm, sifat, ombor partiyasi | → Field, StockBatch |
| Facility (obyekt) | turi (molxona, ombor), sig'imi, koordinatalar | → Farm, Camera |
| Animal (hayvon) | identifikatorlar, tur, zot, jins, tug'ilgan sana, holat, ota-ona | → Herd, Facility, WeightRecord, HealthRecord |
| Herd (poda) | nomi, turi, joylashuv, ratsion | → Animal, Ration, CostCenter |
| Breeding / Lambing | sovliq, qo'chqor, qochirish sanasi, kutilayotgan va haqiqiy qo'zilash, qo'zilar | → Animal |
| WeightRecord | hayvon, sana, vazn, usul | → Animal |
| HealthRecord | hayvon yoki poda, turi (emlash, davolash), preparat, doza, veterinar, natija | → Animal, StockMovement |
| AnimalExit | hayvon, turi (sotuv, so'yish, nobud), sana, vazn, summa | → Animal, Sale |
| Ration | poda toifasi, ozuqa tarkibi (kg/bosh/kun) | → Herd, Item |
| Warehouse / Item / StockBatch | ombor, nomenklatura, partiya, miqdor, tannarx, yaroqlilik | → StockMovement |
| StockMovement | turi (kirim, chiqim, ko'chirish), partiya, miqdor, xarajat markazi, hujjat | → CostCenter |
| CostCenter (xarajat markazi) | turi (dala, poda, hayvon, texnika, umumiy), obyekt | → Transaction |
| Transaction (operatsiya) | sana, turi (xarajat, daromad, o'tkazma), modda, summa, valyuta, to'lov usuli, kontragent, xarajat markazi | → Counterparty, Account, Document |
| Budget | davr, modda, xarajat markazi, reja summa | → CostCenter |
| Account (kassa, bank) | nomi, turi, qoldiq | → Transaction |
| Loan | kreditor, summa, foiz, grafik | → Transaction |
| Counterparty | nomi, STIR, toifa, rekvizitlar | → Contract, Sale, Purchase |
| Sale / Purchase | kontragent, mahsulot, miqdor, narx, hujjatlar | → StockMovement, Transaction |
| Employee / Timesheet / Payroll | xodim, lavozim, ish haqi turi, tabel, hisob-kitob | → User, CostCenter |
| Asset (texnika) | turi, inventar raqami, qiymat, amortizatsiya | → AssetUsageLog, Maintenance |
| Task / CalendarEvent | nomi, mas'ul, muddat, bog'langan obyekt, holat | → User, istalgan obyekt |
| Camera / Device | turi, manzil (RTSP), joylashuv, holati | → Facility, Event |
| Event (hodisa) | manba (kamera, datchik, tizim), turi, sana, obyekt, muhimlik, foto | → istalgan obyekt |
| AIInsight (AI xulosasi) | turi, matn, ishonch darajasi, manba ma'lumotlar, qaror (qabul/rad) | → istalgan obyekt |
| AuditLog | foydalanuvchi, obyekt, amal, oldingi va yangi qiymat, sana | → barcha obyektlar |
| Document | turi, fayl, muddati, bog'langan obyekt | → istalgan obyekt |

## 23. Amalga oshirish bosqichlari va muddatlar

Loyiha to'rt bosqichda amalga oshiriladi; birinchi bosqich Yuksalish Agro ning joriy mavsumiga (kuzgi ekish va qo'y xaridi) ulgurishga qaratilgan. Muddatlar 4–6 kishilik jamoa (backend, frontend, mobil, dizayner, QA, loyiha rahbari) uchun hisoblangan va texnik topshiriq tasdiqlangandan boshlanadi.

&#91;embedded content: yo'l xaritasi · 5 bosqich, 4 o'tish nuqtasi, ferma mavsumi bilan bog'langan\]

Har bir bosqich o'tish nuqtasidagi shart bajarilgandagina keyingisiga o'tadi; MVP ning asosiy sinovi 500 sovliq va 70 ga dalani platformaga kiritish bo'ladi.

| Bosqich | Muddat | Tarkib | Natija |
| --- | --- | --- | --- |
| 0. Tayyorgarlik | 2–3 hafta | TZ ni tasdiqlash, UX-dizayn, ma'lumotlar modeli (ERD), infratuzilmani sozlash, Yuksalish Agro ma'lumotnomalarini yig'ish | Dizayn maketlari, ERD, ishlab chiqish muhiti |
| 1. MVP | 10–12 hafta | Ferma pasporti va dalalar, chorva reyestri va ko'payish, ozuqa ombori va ratsion, moliya (operatsiyalar, byudjet, tannarx), xodimlar (reyestr, tabel), dashboard, mobil ilova (kunlik qaydlar, oflayn), Telegram bildirishnomalar, Excel import/eksport | Yuksalish Agro to'liq ishlay boshlaydi: 500 sovliq va 70 ga dala platformada |
| 2. Kengaytirish va AI | 8–10 hafta | O'simlikchilik to'liq (texnologik karta, reja/fakt), sotuv va kontragentlar, texnika moduli, hisobot konstruktori, AI yordamchi va og'ishlarni aniqlash, moliyaviy prognoz, Keeping integratsiyasi, kamera moduli (jonli ko'rish, arxiv, asosiy hodisalar) | Qo'zilash mavsumi va hosil AI-tahlil bilan yuritiladi |
| 3. Aqlli ferma | 10–12 hafta | Kamera AI-stsenariylari (sanash, harakatsizlik, xavfsizlik), IoT datchiklar va RFID tarozi, GPS-trekerlar, Didox va bank integratsiyasi, naslchilik tahlili, narx monitoringi | To'liq raqamli ferma |
| 4. SaaS ga tayyorlash | 6–8 hafta | Tenant ro'yxatdan o'tish va tariflar, modullarni yoqish/o'chirish, onboarding, hujjatlar, qo'llab-quvvatlash markazi, yuklama sinovlari | Boshqa fermalarga sotishga tayyor platforma |

### 23.1. Yuksalish Agro mavsumiga bog'liq muhim nuqtalar

- Kuzgi ekish (noyabr 2026) MVP dan oldin boshlanadi: dastlabki ma'lumotlar Excel shablonida yig'iladi va MVP ishga tushganda import qilinadi.
- 500 sovliq xaridi: birkalash va ro'yxatga olish MVP ning birinchi real sinovi bo'ladi.
- Qo'zilash (2027 yil bahori) 2-bosqich funksiyalari bilan kutib olinadi.
- Hosil (2027 yil yozi) o'simlikchilik moduli to'liq holda yuritiladi.

## 24. Qabul qilish mezonlari va test

Har bir bosqich quyidagi mezonlar bajarilganda qabul qilinadi; sinov Yuksalish Agro ning real ma'lumotlarida o'tkaziladi.

### 24.1. MVP uchun qabul mezonlari

- [ ] 500 bosh sovliq birka raqami bilan ro'yxatga olingan, har biri uchun bo'g'ozlik sanasi va kutilayotgan qo'zilash sanasi hisoblangan.
- [ ] 70 ga dala xaritada chizilgan, har bir dalaga ekin va mavsum biriktirilgan, maydon avtomatik hisoblangan.
- [ ] Kunlik ozuqa sarfi mobil ilovadan oflayn rejimda kiritilib, aloqa tiklanganda to'g'ri sinxronlangan.
- [ ] Ozuqa qoldig'i va "necha kunga yetadi" ko'rsatkichi haqiqiy sarf asosida to'g'ri hisoblangan.
- [ ] Barcha xarajatlar xarajat markaziga biriktirilgan; 1 bosh sovliqning joriy tannarxi va dala bo'yicha xarajatlar hisoboti chiqadi.
- [ ] Byudjet kiritilgan va reja/fakt farqi dashboardda ko'rinadi.
- [ ] Rollar bo'yicha kirish cheklovlari ishlaydi: cho'pon moliya ma'lumotlarini ko'ra olmaydi.
- [ ] Telegram orqali kunlik xulosa va shoshilinch ogohlantirish keladi.
- [ ] Excel import orqali kuzgi ekish ma'lumotlari yuklangan.
- [ ] 10 ta xodim bir vaqtda ishlaganda tizim 2 soniyadan sekin javob bermaydi.

### 24.2. Test turlari

| Test | Mazmuni |
| --- | --- |
| Birlik va integratsion testlar | Backend hisob-kitob formulalari (tannarx, poda soni, qo'zilash foizi) avtomatik testlar bilan qoplanadi (kamida 80 %) |
| Funksional test | Har bir modul uchun test stsenariylari ro'yxati; QA mutaxassis tomonidan bajariladi |
| Foydalanuvchi qabul testi (UAT) | Yuksalish Agro xodimlari 2 hafta davomida real ma'lumotlarda ishlaydi, kamchiliklar jurnali yuritiladi |
| Oflayn va sinxronizatsiya testi | Internet uzilgan holatda mobil ilovada kiritish va keyin sinxronlash |
| Yuklama testi | 1 000 hayvon, 100 dala, 100 000 hodisa yozuvi bilan unumdorlik |
| Xavfsizlik testi | Tenantlar izolyatsiyasi, huquqlar, OWASP Top 10 bo'yicha tekshiruv |
| Ma'lumotlar to'g'riligi | Platforma hisobotlari qo'lda hisoblangan nazorat raqamlari bilan solishtiriladi |

### 24.3. Hujjatlar topshirish

- Manba kod va joylashtirish yo'riqnomasi (buyurtmachi mulki).
- API hujjati, ERD, arxitektura sxemasi.
- Foydalanuvchi qo'llanmasi (o'zbek, rus) va video-darslar.
- Test hisobotlari va UAT akti.

## 25. Ilovalar

### 25.1. Asosiy hisob-kitob formulalari

Platformada avtomatik hisoblanadigan ko'rsatkichlar quyidagi formulalar asosida amalga oshiriladi. Formulalar ma'lumotnomada saqlanadi va tenant darajasida koeffitsiyentlari sozlanadi.

```latex
Tannarx_{1\,kg} = \frac{X_{ozuqa} + X_{vet} + X_{mehnat} + X_{umumiy}}{\Delta W_{poda}}
```

```latex
Qo'zilash\ foizi = \frac{N_{tug'ilgan\ qo'zilar}}{N_{qochirilgan\ sovliqlar}} \times 100
```

```latex
Ozuqa\ konversiyasi = \frac{Ozuqa_{kg\ quruq\ modda}}{\Delta W_{kg}}
```

```latex
Zaxira\ kunlari = \frac{Qoldiq_{kg}}{\sum (Ratsion_{kg/bosh/kun} \times N_{bosh})}
```

```latex
Tannarx_{1\,t\ hosil} = \frac{X_{urug'} + X_{o'g'it} + X_{suv} + X_{texnika} + X_{mehnat} + X_{umumiy\ ulush}}{Hosil_{t}}
```

```latex
Rentabellik\ (\%) = \frac{Daromad - Xarajat}{Xarajat} \times 100
```

Umumiy xarajatlar (ma'muriy, infratuzilma) xarajat markazlariga quyidagi bazalardan biri bo'yicha taqsimlanadi: bosh soni, maydon (ga), bevosita xarajatlar ulushi yoki ish soati; baza tenant tomonidan tanlanadi.

### 25.2. Yuksalish Agro boshlang'ich ma'lumotlari (import shabloni)

MVP ishga tushgunga qadar quyidagi ma'lumotlar Excel shablonida yig'iladi va keyin platformaga import qilinadi.

| Shablon | Ustunlar |
| --- | --- |
| Dalalar | Dala raqami, maydoni (ga), ekin, nav, ekish sanasi, urug' me'yori, sug'orish manbai, koordinatalar (ixtiyoriy) |
| Hayvonlar | Birka raqami, zoti, jinsi, tug'ilgan sana yoki yoshi, vazni, bo'g'ozlik sanasi, sotib olish sanasi va narxi, sotuvchi |
| Ozuqa qoldig'i | Ozuqa turi, miqdori, o'lchov birligi, kirim sanasi, narxi |
| Xodimlar | Ism, lavozim, ish haqi turi va miqdori, ishga qabul sanasi, telefon |
| Texnika | Nomi, turi, inventar raqami, xarid sanasi va narxi, holati |
| Kontragentlar | Nomi, STIR, toifa, telefon, bank rekvizitlari |
| Boshlang'ich xarajatlar | Sana, modda, summa, to'lov usuli, xarajat markazi, izoh |
| Byudjet 2026/27 | Oy, modda, reja summa |

### 25.3. Kamera joylashuvi bo'yicha boshlang'ich reja

| Joy | Kameralar soni | Maqsad |
| --- | --- | --- |
| Molxona ichi | 4–6 | Hayvonlarni sanash, harakatsizlik, qo'zilash, oxur holati |
| Ozuqa ombori | 2 | Kirim-chiqim nazorati, yong'in belgilari |
| Asosiy darvoza va hovli | 2 | Transport, notanish shaxslar, ish vaqtidan tashqari harakat |
| Suv va nasos inshooti | 1 | Texnik holat |
| Jami | 9–11 | 30 kunlik lokal arxiv, hodisa kliplari bulutda |

### 25.4. Ochiq savollar

- [x] 140 ga qoldiq maydonning aniq taqsimoti (yaylov, qurilish, zaxira).
- [x] 70 ga ichida ekinlar bo'yicha aniq maydon taqsimoti (bug'doy, sholi, beda, arpa).
- [x] Qo'ylar qaysi sanada va qaysi sotuvchidan olinadi; birkalash standarti (quloq birkasi yoki RFID).
- [x] Ferma yuridik shakli va soliq rejimi (Keeping integratsiyasi uchun).
- [x] Fermadagi internet imkoniyati va elektr ta'minoti (kamera va edge-server uchun).
- [x] Ishlab chiqish jamoasi tarkibi va boshlanish sanasi.
- [x] Platformaning doimiy nomi va domeni (yuksalishagro.uz yoki alohida mahsulot brendi).
