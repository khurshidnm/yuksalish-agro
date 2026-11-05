/**
 * What people call farm goods, machines and herds, in Uzbek, Russian and English. A record whose
 * name holds one of a group's words also answers to the rest, so "salyarka" finds Dizel, "отрубей"
 * finds Kepak and "plough" finds Plug PLN-3-35. Russian words are stems, because the matcher adds the
 * endings. A spelling that only differs by script needs no entry: the matcher compares sounds.
 */

/** Goods, each group one thing. */
export const GOODS = [
  "bug'doy, пшениц, wheat",
  'arpa, ячмен, barley',
  'beda, люцерн, alfalfa, lucerne',
  'pichan, сено, hay',
  'kepak, отруб, bran',
  'kunjara, жмых, oilcake, cake',
  'somon, солом, straw',
  'tuz, сол, salt',
  'silos, silage',
  'sholi, guruch, рис, rice',
  "makkajo'xori, kukuruza, кукуруз, maize, corn",
  'karbamid, мочевин, urea',
  'ammofos, ammophos',
  'selitra, селитр, nitrate',
  'dizel, salyarka, solyarka, солярк, соляр, diesel',
  'benzin, petrol, gasoline',
  'mineral, premiks, minerals, premix',
  'jun, шерст, wool',
  "go'sht, мясо, meat",
  'chechak, осп, pox',
  'oqsil, ящур, fmd',
].map((group) => group.split(',').map((word) => word.trim()));

/** Words for a kind of stock item: "yoqilg'i" is the farm's only fuel. */
export const ITEM_KINDS: Record<string, string[]> = {
  feed: ['yem', 'ozuqa', 'корм', 'feed'],
  seed: ["urug'", "urug'lik", 'urugluk', 'семен', 'семян', 'seed', 'seeds'],
  fertilizer: ["o'g'it", 'удобрение', 'fertilizer', 'fertiliser'],
  chemical: ['pestitsid', 'gerbitsid', 'пестицид', 'гербицид', 'pesticide', 'herbicide'],
  vet_drug: ['dori', 'лекарство', 'препарат', 'medicine', 'drug'],
  vaccine: ['vaksina', 'вакцин', 'vaccine'],
  fuel: ["yoqilg'i", 'топливо', 'горючее', 'fuel'],
  lubricant: ['смазк', 'lubricant'],
  spare_part: ['запчаст', 'spare'],
};

/** Words for a kind of machine, by asset type. */
export const MACHINES: Record<string, string[]> = {
  tractor: ['traktor', 'трактор', 'tractor'],
  combine: ['kombayn', 'комбайн', 'combine', 'harvester'],
  seeder: ['seyalka', 'сеялк', 'seeder', 'drill'],
  plough: ['plug', 'плуг', 'plough', 'plow'],
  pump: ['nasos', 'насос', 'pump'],
  generator: ['generator', 'генератор'],
  scale: ['tarozi', 'весы', 'scale', 'scales'],
  camera: ['kamera', 'камер', 'camera'],
  vehicle: ['mashina', 'avtomobil', 'машин', 'автомобил', 'car', 'truck', 'vehicle'],
};

export const HERD_WORDS = ['suruv', 'poda', 'отара', 'стадо', 'herd', 'flock'];

/** Words that only say a place is meant: with a number they name it, as in "3-dala" or "третье поле". */
export const PLACE_WORDS = ['dala', 'maydon', 'uchastka', 'участок', 'участк', 'поле', 'field', 'plot'];

/** Ordinal words, written as people do: "uchinchi dala", "третье поле", "the second field". */
export const ORDINALS: [number, string][] = [
  [1, "birinchi|биринчи|перв[а-я]*|first"],
  [2, "ikkinchi|иккинчи|втор[а-я]*|second"],
  [3, "uchinchi|учинчи|трет[а-я]*|third"],
  [4, "to['ʻ’‘`]?rtinchi|тўртинчи|четв[её]рт[а-я]*|fourth"],
  [5, "beshinchi|бешинчи|пят[а-я]+|fifth"],
  [6, "oltinchi|олтинчи|шест[а-я]+|sixth"],
  [7, "yettinchi|еттинчи|седьм[а-я]*|seventh"],
  [8, "sakkizinchi|саккизинчи|восьм[а-я]*|eighth"],
  [9, "to['ʻ’‘`]?qqizinchi|тўққизинчи|девят[а-я]+|ninth"],
  [10, "o['ʻ’‘`]?ninchi|ўнинчи|десят[а-я]+|tenth"],
];
