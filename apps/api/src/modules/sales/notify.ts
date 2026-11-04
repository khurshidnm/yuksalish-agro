/** Tell the next person in a flow that something waits for them. The text never contains money. */
import type { Permission, RoleKey } from '@yap/shared';
import { ctx } from '../../core/context';
import { tr } from '../notifications/i18n';
import { notifyRole } from '../notifications/notify.service';

function tell(roles: RoleKey[], key: string, params: Record<string, string>, link: string, permission: Permission) {
  const self = ctx().userId;
  return notifyRole(
    roles,
    {
      severity: 'attention',
      title: (locale) => tr(locale, 'sales', `notify.${key}.title`, params),
      body: (locale) => tr(locale, 'sales', `notify.${key}.body`, params),
      link,
    },
    { permission, exclude: self ? [self] : [] },
  );
}

export const notifySaleSubmitted = (number: string) =>
  tell(['owner', 'director'], 'saleSubmitted', { number }, '/sales', 'sales.approve');

export const notifyPurchaseRequested = (itemName: string) =>
  tell(['owner', 'director'], 'purchaseRequested', { item: itemName }, '/sales/purchases', 'sales.approve');

export const notifyPurchaseApproved = (itemName: string) =>
  tell(['accountant'], 'purchaseApproved', { item: itemName }, '/sales/purchases', 'finance.create');

export const notifyPurchasePaid = (itemName: string) =>
  tell(['storekeeper'], 'purchasePaid', { item: itemName }, '/sales/purchases', 'inventory.create');
