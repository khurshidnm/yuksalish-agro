import { CloudUpload, Loader2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { outbox, useOutbox } from '@/lib/outbox';

/** Always visible while anything is unsent, on every screen: a queue nobody sees gets forgotten. */
export function OutboxBar() {
  const { t } = useTranslation('today');
  const { records, syncing, unreachable } = useOutbox();

  const attention = records.filter((r) => r.status !== 'pending').length;
  const waiting = records.length - attention;
  if (records.length === 0) return null;

  if (attention > 0) {
    return (
      <Link
        to="/today/sync"
        role="status"
        data-testid="outbox-bar"
        className="focus-ring flex min-h-14 items-center justify-center gap-2 bg-danger-soft px-4 py-2 text-base font-semibold text-danger"
      >
        <TriangleAlert className="size-5 shrink-0" aria-hidden />
        {t('bar.attention', { n: attention })}
      </Link>
    );
  }

  const offline = unreachable || !navigator.onLine;
  return (
    <div role="status" data-testid="outbox-bar" className="flex min-h-14 items-center justify-center gap-3 bg-warning-soft px-4 text-base font-semibold text-warning">
      {syncing && !offline ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <CloudUpload className="size-5 shrink-0" aria-hidden />}
      <Link to="/today/sync" className="focus-ring flex min-h-14 items-center underline-offset-2 hover:underline">
        {t(syncing && !offline ? 'bar.syncing' : 'bar.waiting', { n: waiting })}
      </Link>
      {/* Worth offering when the browser thinks it is online: Wi-Fi with no internet looks like that. */}
      {!syncing && navigator.onLine && (
        <button type="button" className="focus-ring min-h-14 shrink-0 rounded-md px-2 underline" onClick={() => void outbox.flush({ force: true })}>
          {t('bar.retry')}
        </button>
      )}
    </div>
  );
}
