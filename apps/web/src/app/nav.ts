import type { Module, Permission } from '@yap/shared';
import {
  BadgeDollarSign,
  Banknote,
  Bell,
  BookUser,
  Bot,
  Boxes,
  Building2,
  Calculator,
  CalendarDays,
  CalendarRange,
  Camera,
  ChartColumn,
  ChartPie,
  CircleMinus,
  ClipboardCheck,
  ClipboardList,
  CloudSun,
  Coins,
  CreditCard,
  Droplets,
  FileSpreadsheet,
  FileText,
  Files,
  HeartPulse,
  Inbox,
  History,
  KeyRound,
  Landmark,
  Layers,
  LayoutDashboard,
  LineChart,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  MapPinned,
  PackageSearch,
  PawPrint,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sprout,
  Store,
  Sun,
  Tractor,
  TriangleAlert,
  Truck,
  UserCog,
  Users,
  Warehouse,
  Wheat,
} from 'lucide-react';

export interface NavItem {
  /** Label key: nav:item.<key>. */
  key: string;
  to: string;
  icon: LucideIcon;
  /** Hidden unless the user holds this, or any of these. None means every signed-in user. */
  permission?: Permission | Permission[];
  /** Hidden when the tenant has this module switched off. Defaults to the permission's module. */
  module?: Module;
  platformOnly?: boolean;
}

export interface NavSection {
  /** Label key: nav:section.<key>. */
  key: string;
  icon: LucideIcon;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    key: 'overview',
    icon: LayoutDashboard,
    items: [
      { key: 'dashboard', to: '/', icon: LayoutDashboard, permission: 'dashboard.view' },
      { key: 'today', to: '/today', icon: Sun },
      { key: 'tasks', to: '/tasks', icon: ListChecks, permission: 'tasks.view' },
      { key: 'calendar', to: '/calendar', icon: CalendarDays, permission: 'tasks.view' },
      { key: 'alerts', to: '/alerts', icon: TriangleAlert, permission: 'dashboard.view' },
      { key: 'notifications', to: '/notifications', icon: Bell },
    ],
  },
  {
    key: 'land',
    icon: Sprout,
    items: [
      { key: 'farmPassport', to: '/farm', icon: Building2, permission: 'farm.view' },
      { key: 'map', to: '/farm/map', icon: MapIcon, permission: 'farm.view' },
      { key: 'fields', to: '/farm/fields', icon: MapPinned, permission: 'farm.view' },
      { key: 'water', to: '/farm/water', icon: Droplets, permission: 'farm.view' },
      { key: 'facilities', to: '/farm/facilities', icon: Warehouse, permission: 'farm.view' },
      { key: 'documents', to: '/farm/documents', icon: Files, permission: 'farm.view' },
      { key: 'cropPlans', to: '/crops/plans', icon: CalendarRange, permission: 'crops.view' },
      { key: 'operations', to: '/crops/operations', icon: ClipboardCheck, permission: 'crops.view' },
      { key: 'harvests', to: '/crops/harvests', icon: Wheat, permission: 'crops.view' },
    ],
  },
  {
    key: 'livestock',
    icon: PawPrint,
    items: [
      { key: 'animals', to: '/livestock/animals', icon: PawPrint, permission: 'livestock.view' },
      { key: 'herds', to: '/livestock/herds', icon: Layers, permission: 'livestock.view' },
      { key: 'breeding', to: '/livestock/breeding', icon: CloudSun, permission: 'livestock.view' },
      { key: 'health', to: '/livestock/health', icon: HeartPulse, permission: 'health.view' },
      { key: 'dailyLogs', to: '/livestock/daily-logs', icon: ClipboardList, permission: 'livestock.view' },
      { key: 'exits', to: '/livestock/exits', icon: CircleMinus, permission: 'livestock.view' },
    ],
  },
  {
    key: 'warehouse',
    icon: Boxes,
    items: [
      { key: 'stock', to: '/inventory/stock', icon: Boxes, permission: 'inventory.view' },
      { key: 'movements', to: '/inventory/movements', icon: Truck, permission: 'inventory.view' },
      { key: 'items', to: '/inventory/items', icon: PackageSearch, permission: 'inventory.view' },
      { key: 'warehouses', to: '/inventory/warehouses', icon: Warehouse, permission: 'inventory.view' },
      { key: 'counts', to: '/inventory/counts', icon: Scale, permission: 'inventory.view' },
      { key: 'rations', to: '/feed/rations', icon: Wheat, permission: 'feed.view' },
      { key: 'feedBalance', to: '/feed/balance', icon: ChartColumn, permission: 'feed.view' },
      { key: 'winterPlan', to: '/feed/winter-plan', icon: Calculator, permission: 'feed.view' },
    ],
  },
  {
    key: 'finance',
    icon: Coins,
    items: [
      { key: 'transactions', to: '/finance/transactions', icon: Receipt, permission: 'finance.view' },
      { key: 'accounts', to: '/finance/accounts', icon: Landmark, permission: 'finance.view' },
      { key: 'counterparties', to: '/finance/counterparties', icon: BookUser, permission: 'finance.view' },
      { key: 'debts', to: '/finance/debts', icon: CreditCard, permission: 'finance.view' },
      { key: 'budget', to: '/finance/budget', icon: ChartPie, permission: 'finance.view' },
      { key: 'costs', to: '/finance/costs', icon: BadgeDollarSign, permission: 'finance.view' },
      { key: 'cashflow', to: '/finance/cashflow', icon: LineChart, permission: 'finance.view' },
      { key: 'loans', to: '/finance/loans', icon: Banknote, permission: 'finance.view' },
    ],
  },
  {
    key: 'sales',
    icon: Store,
    items: [
      { key: 'sales', to: '/sales', icon: Store, permission: 'sales.view' },
      { key: 'purchases', to: '/sales/purchases', icon: ShoppingCart, permission: 'inventory.view', module: 'sales' },
    ],
  },
  {
    key: 'people',
    icon: Users,
    items: [
      { key: 'employees', to: '/hr/employees', icon: Users, permission: 'hr.view' },
      { key: 'timesheet', to: '/hr/timesheet', icon: CalendarDays, permission: 'hr.view' },
      { key: 'payroll', to: '/hr/payroll', icon: Banknote, permission: 'payroll.view' },
    ],
  },
  {
    key: 'machinery',
    icon: Tractor,
    items: [
      { key: 'assets', to: '/assets', icon: Tractor, permission: 'assets.view' },
      { key: 'cameras', to: '/cameras', icon: Camera, permission: 'cameras.view' },
    ],
  },
  {
    key: 'analytics',
    icon: ChartColumn,
    items: [
      { key: 'reports', to: '/reports', icon: FileText, permission: 'reports.view' },
      { key: 'ai', to: '/ai', icon: Bot, permission: 'ai.view' },
    ],
  },
  {
    key: 'admin',
    icon: Settings,
    items: [
      {
        key: 'import',
        to: '/import',
        icon: FileSpreadsheet,
        // Whoever can import something: each template checks its own permissions on the server.
        permission: ['finance.create', 'livestock.update', 'farm.create', 'inventory.create', 'hr.create', 'assets.create'],
        module: 'dashboard',
      },
      { key: 'settings', to: '/settings', icon: Settings, permission: 'settings.view' },
      { key: 'users', to: '/settings/users', icon: Users, permission: 'users.view' },
      { key: 'apiKeys', to: '/settings/api-keys', icon: KeyRound, permission: 'settings.update' },
      { key: 'audit', to: '/settings/audit', icon: History, permission: 'audit.view' },
    ],
  },
  {
    key: 'platform',
    icon: ShieldCheck,
    items: [
      { key: 'platform', to: '/platform', icon: ShieldCheck, platformOnly: true },
      { key: 'leads', to: '/platform/leads', icon: Inbox, platformOnly: true },
      { key: 'platformUsers', to: '/platform/users', icon: UserCog, platformOnly: true },
    ],
  },
];

/** Phone bottom bar per role: the screens that role opens all day. A fifth slot opens the full menu. */
const BOTTOM_BY_ROLE: Record<string, string[]> = {
  owner: ['dashboard', 'alerts', 'transactions', 'reports'],
  director: ['dashboard', 'alerts', 'tasks', 'reports'],
  accountant: ['dashboard', 'transactions', 'counterparties', 'reports'],
  agronomist: ['today', 'fields', 'operations', 'tasks'],
  zootechnician: ['today', 'animals', 'herds', 'breeding'],
  veterinarian: ['today', 'health', 'animals', 'tasks'],
  storekeeper: ['today', 'stock', 'movements', 'tasks'],
  mechanic: ['today', 'tasks', 'operations', 'assets'],
  shepherd: ['today', 'dailyLogs', 'animals', 'tasks'],
  investor: ['dashboard', 'reports'],
  auditor: ['dashboard', 'transactions', 'audit', 'reports'],
};

const BOTTOM_DEFAULT = ['dashboard', 'today', 'tasks', 'notifications'];

export function bottomKeys(roleKey: string | undefined): string[] {
  return (roleKey && BOTTOM_BY_ROLE[roleKey]) || BOTTOM_DEFAULT;
}
