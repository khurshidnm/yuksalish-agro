import i18n from '@/lib/i18n';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import type { SaleDetail } from '../types';

const escape = (value: string | null | undefined) =>
  (value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * Waybill (yuk xati, spec 13.2) in a new window, printed by the browser, so any printer or
 * "Save as PDF" works in every script the interface supports. Values are escaped: names come from users.
 */
export function printWaybill(sale: SaleDetail, farmName: string): void {
  const t = (key: string) => escape(i18n.t(`sales:print.${key}`));
  const product = (l: SaleDetail['lines'][number]) =>
    l.animalTag ? `${i18n.t(`enums:animalCategory.${l.animalCategory}`)}, ${l.animalTag}` : (l.itemName ?? l.description ?? '');

  const rows = sale.lines
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escape(product(l))}</td>
        <td class="n">${escape(formatQty(l.qty, i18n.t(`enums:unit.${l.unit}`)))}</td>
        <td class="n">${escape(formatMoney(l.price, { currency: sale.currency }))}</td>
        <td class="n">${escape(formatMoney(l.amount, { currency: sale.currency }))}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(sale.number)}</title><style>
    body { font: 14px/1.5 system-ui, sans-serif; color: #111; margin: 32px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
    .n { text-align: right; white-space: nowrap; }
    .meta { margin: 2px 0; }
    .sign { display: flex; justify-content: space-between; gap: 32px; margin-top: 48px; }
    .sign div { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 12px; }
  </style></head><body>
    <h1>${t('title')} ${escape(sale.number)}</h1>
    <p class="meta">${t('date')}: ${escape(formatDate(sale.date))}</p>
    <p class="meta">${t('seller')}: ${escape(farmName)}</p>
    <p class="meta">${t('buyer')}: ${escape(sale.counterpartyName)}${sale.counterpartyTin ? `, ${t('tin')} ${escape(sale.counterpartyTin)}` : ''}</p>
    ${sale.deliveryDate ? `<p class="meta">${t('delivery')}: ${escape(formatDate(sale.deliveryDate))}</p>` : ''}
    <table>
      <thead><tr><th>№</th><th>${t('product')}</th><th class="n">${t('qty')}</th><th class="n">${t('price')}</th><th class="n">${t('amount')}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="4">${t('total')}</th><th class="n">${escape(formatMoney(sale.totalAmount, { currency: sale.currency }))}</th></tr></tfoot>
    </table>
    <div class="sign"><div>${t('handedOver')}</div><div>${t('received')}</div></div>
  </body></html>`;

  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  // From here, not a script in the page: the new window inherits this page's CSP, which would refuse it.
  win.print();
}
