import uzCommon from './locales/uz/common.json';
import uzNav from './locales/uz/nav.json';
import uzAuth from './locales/uz/auth.json';
import uzEnums from './locales/uz/enums.json';
import uzDashboard from './locales/uz/dashboard.json';
import uzFarm from './locales/uz/farm.json';
import uzCrops from './locales/uz/crops.json';
import uzLivestock from './locales/uz/livestock.json';
import uzVet from './locales/uz/vet.json';
import uzInventory from './locales/uz/inventory.json';
import uzFeed from './locales/uz/feed.json';
import uzFinance from './locales/uz/finance.json';
import uzHr from './locales/uz/hr.json';
import uzAssets from './locales/uz/assets.json';
import uzSales from './locales/uz/sales.json';
import uzTasks from './locales/uz/tasks.json';
import uzAlerts from './locales/uz/alerts.json';
import uzCameras from './locales/uz/cameras.json';
import uzReports from './locales/uz/reports.json';
import uzAi from './locales/uz/ai.json';
import uzSettings from './locales/uz/settings.json';
import uzImport from './locales/uz/import.json';
import uzToday from './locales/uz/today.json';
import uzPlatform from './locales/uz/platform.json';
import ruCommon from './locales/ru/common.json';
import ruNav from './locales/ru/nav.json';
import ruAuth from './locales/ru/auth.json';
import ruEnums from './locales/ru/enums.json';
import ruDashboard from './locales/ru/dashboard.json';
import ruFarm from './locales/ru/farm.json';
import ruCrops from './locales/ru/crops.json';
import ruLivestock from './locales/ru/livestock.json';
import ruVet from './locales/ru/vet.json';
import ruInventory from './locales/ru/inventory.json';
import ruFeed from './locales/ru/feed.json';
import ruFinance from './locales/ru/finance.json';
import ruHr from './locales/ru/hr.json';
import ruAssets from './locales/ru/assets.json';
import ruSales from './locales/ru/sales.json';
import ruTasks from './locales/ru/tasks.json';
import ruAlerts from './locales/ru/alerts.json';
import ruCameras from './locales/ru/cameras.json';
import ruReports from './locales/ru/reports.json';
import ruAi from './locales/ru/ai.json';
import ruSettings from './locales/ru/settings.json';
import ruImport from './locales/ru/import.json';
import ruToday from './locales/ru/today.json';
import ruPlatform from './locales/ru/platform.json';
import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enAuth from './locales/en/auth.json';
import enEnums from './locales/en/enums.json';
import enDashboard from './locales/en/dashboard.json';
import enFarm from './locales/en/farm.json';
import enCrops from './locales/en/crops.json';
import enLivestock from './locales/en/livestock.json';
import enVet from './locales/en/vet.json';
import enInventory from './locales/en/inventory.json';
import enFeed from './locales/en/feed.json';
import enFinance from './locales/en/finance.json';
import enHr from './locales/en/hr.json';
import enAssets from './locales/en/assets.json';
import enSales from './locales/en/sales.json';
import enTasks from './locales/en/tasks.json';
import enAlerts from './locales/en/alerts.json';
import enCameras from './locales/en/cameras.json';
import enReports from './locales/en/reports.json';
import enAi from './locales/en/ai.json';
import enSettings from './locales/en/settings.json';
import enImport from './locales/en/import.json';
import enToday from './locales/en/today.json';
import enPlatform from './locales/en/platform.json';
import { latinToCyrillic, mapStrings } from './translit';

export { latinToCyrillic, mapStrings } from './translit';

/** Interface languages. Uzbek Cyrillic is derived from Uzbek Latin, so it needs no dictionary of its own. */
export const LANGUAGES = [
  { code: 'uz', label: "O'zbekcha" },
  { code: 'uz-Cyrl', label: 'Ўзбекча' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const NAMESPACES = [
  'common',
  'nav',
  'auth',
  'enums',
  'dashboard',
  'farm',
  'crops',
  'livestock',
  'vet',
  'inventory',
  'feed',
  'finance',
  'hr',
  'assets',
  'sales',
  'tasks',
  'alerts',
  'cameras',
  'reports',
  'ai',
  'settings',
  'import',
  'today',
  'platform',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

type Bundle = Record<Namespace, unknown>;

const uz: Bundle = {
  common: uzCommon,
  nav: uzNav,
  auth: uzAuth,
  enums: uzEnums,
  dashboard: uzDashboard,
  farm: uzFarm,
  crops: uzCrops,
  livestock: uzLivestock,
  vet: uzVet,
  inventory: uzInventory,
  feed: uzFeed,
  finance: uzFinance,
  hr: uzHr,
  assets: uzAssets,
  sales: uzSales,
  tasks: uzTasks,
  alerts: uzAlerts,
  cameras: uzCameras,
  reports: uzReports,
  ai: uzAi,
  settings: uzSettings,
  import: uzImport,
  today: uzToday,
  platform: uzPlatform,
};

const ru: Bundle = {
  common: ruCommon,
  nav: ruNav,
  auth: ruAuth,
  enums: ruEnums,
  dashboard: ruDashboard,
  farm: ruFarm,
  crops: ruCrops,
  livestock: ruLivestock,
  vet: ruVet,
  inventory: ruInventory,
  feed: ruFeed,
  finance: ruFinance,
  hr: ruHr,
  assets: ruAssets,
  sales: ruSales,
  tasks: ruTasks,
  alerts: ruAlerts,
  cameras: ruCameras,
  reports: ruReports,
  ai: ruAi,
  settings: ruSettings,
  import: ruImport,
  today: ruToday,
  platform: ruPlatform,
};

const en: Bundle = {
  common: enCommon,
  nav: enNav,
  auth: enAuth,
  enums: enEnums,
  dashboard: enDashboard,
  farm: enFarm,
  crops: enCrops,
  livestock: enLivestock,
  vet: enVet,
  inventory: enInventory,
  feed: enFeed,
  finance: enFinance,
  hr: enHr,
  assets: enAssets,
  sales: enSales,
  tasks: enTasks,
  alerts: enAlerts,
  cameras: enCameras,
  reports: enReports,
  ai: enAi,
  settings: enSettings,
  import: enImport,
  today: enToday,
  platform: enPlatform,
};

export const resources: Record<LanguageCode, Bundle> = {
  uz,
  'uz-Cyrl': mapStrings(uz, latinToCyrillic),
  ru,
  en,
};
