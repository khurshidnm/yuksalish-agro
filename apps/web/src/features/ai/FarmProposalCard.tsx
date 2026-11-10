import { Check, ExternalLink, Send, Undo2, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Badge, Button } from '@/components/ui';
import { categoryLabel } from '@/features/livestock/category';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime, formatNumber, formatQty } from '@/lib/format';
import { errorMessage } from '@/lib/query';
import { type FarmNotice, afterFarmRefusal, farmRecordLink, herdOnCard, onlyCancelLeft, readFarmRefusal } from './farm-proposals';
import { clockText, undoSecondsLeft, warningKeys } from './proposals';
import type { FarmAnimal, FarmProposalView } from './types';
import { useFarmProposal } from './useFarmProposal';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{children}</dd>
    </>
  );
}

/** The animal named plainly: tag, what it is, how old on the record's day. */
function AnimalName({ animal }: { animal: FarmAnimal }) {
  const { t } = useTranslation('ai');
  const what = animal.category ? categoryLabel(animal.category, animal.species) : animal.sex ? t(`enums:sex.${animal.sex}`) : null;
  const age = animal.ageMonths === null ? t('farmRecords.ageUnknown') : t('farmRecords.ageMonths', { months: animal.ageMonths });
  return (
    <>
      <span className="tabular-nums" data-testid="farm-animal-tag">
        {animal.tag}
      </span>
      <span className="block text-sm font-normal text-muted-foreground">{[what, age].filter(Boolean).join(', ')}</span>
    </>
  );
}

/** What the eye lands on first: the figure or the name that makes this record what it is. */
function headline(proposal: FarmProposalView): string | null {
  const f = proposal.fields;
  switch (proposal.kind) {
    case 'weight':
      return f.weightKg === null ? null : formatQty(f.weightKg, 'kg', 2);
    case 'death':
      return f.animal?.tag ?? null;
    case 'treatment':
      return f.drug?.name ?? null;
    case 'herd_log':
      return f.herd?.name ?? null;
    default:
      return null;
  }
}

function Details({ proposal }: { proposal: FarmProposalView }) {
  const { t } = useTranslation('ai');
  const f = proposal.fields;
  const herd = herdOnCard(f);
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {f.animal && (
        <Row label={t('farmRecords.fields.animal')}>
          <AnimalName animal={f.animal} />
        </Row>
      )}
      {herd && (
        <Row label={t('farmRecords.fields.herd')}>
          {herd.name ?? t('farmRecords.noHerd')}
          {herd.defaulted && (
            <span className="mt-0.5 block text-sm font-normal text-warning" data-testid="farm-herd-defaulted">
              {t('farmRecords.herdDefaulted')}
            </span>
          )}
        </Row>
      )}
      {f.weightKg !== null && <Row label={t('farmRecords.fields.weight')}>{formatQty(f.weightKg, 'kg', 2)}</Row>}
      {f.healthType && <Row label={t('farmRecords.fields.care')}>{t(`enums:healthRecordType.${f.healthType}`)}</Row>}
      {f.drug && <Row label={t('farmRecords.fields.drug')}>{f.drug.name}</Row>}
      {f.dose !== null && <Row label={t('farmRecords.fields.dose')}>{formatQty(f.dose, f.doseUnit)}</Row>}
      {f.headCount !== null && <Row label={t('farmRecords.fields.headCount')}>{formatNumber(f.headCount, 0)}</Row>}
      {f.stockOut.map((line) => (
        <Row key={line.itemId} label={t('farmRecords.fields.stockOut')}>
          <span data-testid="farm-stock-out">
            {line.name}, {formatQty(line.qty, line.unit)}
          </span>
          <span className="block text-sm font-normal text-muted-foreground">{line.warehouse?.name ?? t('farmRecords.warehouseByRule')}</span>
        </Row>
      ))}
      <Row label={t('farmRecords.fields.date')}>{formatDate(f.date)}</Row>
      {f.cause && <Row label={t('farmRecords.fields.cause')}>{f.cause}</Row>}
    </dl>
  );
}

function NoticeAlert({ notice }: { notice: FarmNotice }) {
  const { t } = useTranslation('ai');
  switch (notice.code) {
    case 'PROPOSAL_CHANGED':
      return (
        <Alert tone="warning" title={t('records.notice.changedTitle')} data-testid="farm-proposal-changed">
          {t('records.notice.changedUnnamed')}
        </Alert>
      );
    case 'PROPOSAL_STALE':
      return (
        <Alert tone="warning" title={t('records.notice.staleTitle')} data-testid="farm-proposal-stale">
          {t('farmRecords.staleBody')}
        </Alert>
      );
    case 'FARM_RECORD_EXISTS':
      return (
        <Alert tone="warning" title={t('farmRecords.existsTitle')} data-testid="farm-proposal-exists">
          {t('farmRecords.existsBody')}
        </Alert>
      );
    default:
      return null;
  }
}

/** Ticks once a second, only while the undo window is open. */
function useSecondsLeft(undoUntil: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const left = undoSecondsLeft(undoUntil, now);
  useEffect(() => {
    if (left <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

function Outcome({ proposal, onUndo, undoing }: { proposal: FarmProposalView; onUndo: () => void; undoing: boolean }) {
  const { t } = useTranslation('ai');
  const can = useCan();
  const confirmed = proposal.status === 'confirmed';
  const left = useSecondsLeft(confirmed && proposal.canUndo ? proposal.undoUntil : null);
  const link = farmRecordLink(proposal, can);

  return (
    <div className="flex flex-col gap-2" data-testid="farm-proposal-outcome">
      {confirmed && (
        <Alert tone="success" title={t('records.outcome.confirmedTitle')}>
          {t('farmRecords.confirmedBody')}
          {/* No window was opened: this kind, or this person, has no safe way back from here. */}
          {proposal.undoUntil === null && <span className="mt-1 block">{t('farmRecords.noUndo')}</span>}
        </Alert>
      )}
      {proposal.status === 'failed' && (
        <Alert tone="danger" title={t('records.outcome.failedTitle')}>
          {t('records.outcome.failedBody')}
        </Alert>
      )}
      {(proposal.status === 'rejected' || proposal.status === 'expired') && (
        <Alert tone="info" title={t(`records.outcome.${proposal.status}Title`)}>
          {t(`records.outcome.${proposal.status}Body`)}
        </Alert>
      )}
      {proposal.status === 'undone' && (
        <Alert tone="info" title={t('records.outcome.undoneTitle')}>
          {t('farmRecords.undoneBody')}
        </Alert>
      )}
      {(left > 0 || link) && (
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {left > 0 && (
            <Button variant="outline" loading={undoing} onClick={onUndo} data-testid="farm-proposal-undo">
              <Undo2 aria-hidden />
              {t('records.actions.undo', { time: clockText(left) })}
            </Button>
          )}
          {link && (
            <Button asChild variant="outline">
              <Link to={link} data-testid="farm-proposal-link">
                <ExternalLink aria-hidden />
                {t('records.actions.open')}
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A prepared farm record: a weight, a death, a treatment, a day's feeding. It carries no money, so
 * everyone reads the same card. A correction is said in the chat, which changes this card in place.
 */
export function FarmProposalCard({ proposal: snapshot }: { proposal: FarmProposalView }) {
  const { t } = useTranslation('ai');
  const { proposal, confirm, reject, undo } = useFarmProposal(snapshot);
  const [refused, setRefused] = useState<FarmNotice | null>(null);

  const isPending = proposal.status === 'pending';
  // An older stored card does not say; the server decides at confirm either way.
  const allowed = proposal.canConfirm ?? true;
  const notice = refused?.stamp === proposal.stamp ? refused : null;
  const awaitingAnswer = proposal.needsAnswer || notice?.code === 'PROPOSAL_NEEDS_ANSWER';
  const canConfirm = allowed && !awaitingAnswer && !onlyCancelLeft(notice);
  const error = confirm.error ?? reject.error ?? undo.error;
  const busy = confirm.isPending || reject.isPending;
  const title = headline(proposal);

  const onConfirm = () => {
    const read = proposal;
    confirm.mutate(
      { stamp: read.stamp },
      {
        onError: (failure) => {
          const refusal = readFarmRefusal(failure);
          if (!refusal) return;
          // The card itself now says what happened, so the bare error would only repeat it.
          confirm.reset();
          setRefused(afterFarmRefusal(refusal, read));
        },
      },
    );
  };

  return (
    <section
      aria-label={t(`farmRecords.kind.${proposal.kind}`)}
      data-testid="farm-proposal-card"
      data-kind={proposal.kind}
      data-status={proposal.status}
      className="flex w-full max-w-xl min-w-0 flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:p-4"
    >
      {title && (
        <p className="text-3xl leading-tight font-bold break-words tabular-nums" data-testid="farm-proposal-headline">
          {title}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="info">{t(`farmRecords.kind.${proposal.kind}`)}</Badge>
        {proposal.channel === 'telegram' && (
          <Badge variant="outline">
            <Send aria-hidden />
            {t('records.channel.telegram')}
          </Badge>
        )}
      </div>

      <Details proposal={proposal} />

      {proposal.sourceText && (
        <p className="text-sm text-muted-foreground">
          {t('farmRecords.fields.said')}: <span className="break-words italic">{proposal.sourceText}</span>
        </p>
      )}

      {isPending && (
        <>
          {proposal.warnings.map((warning, i) => (
            <Alert key={i} tone="warning" data-testid={`farm-warning-${warning.code}`}>
              {t(warningKeys(warning), { ...warning.params, date: formatDate(warning.params.date as string | undefined) })}
            </Alert>
          ))}
          {proposal.kind === 'death' && <Alert tone="warning">{t('farmRecords.deathNote')}</Alert>}
          {proposal.kind === 'herd_log' && <Alert tone="info">{t('farmRecords.herdLogNote')}</Alert>}
          {notice && <NoticeAlert notice={notice} />}
          {awaitingAnswer && (
            <Alert tone="warning" title={t('records.notice.needsAnswerTitle')} data-testid="farm-proposal-needs-answer">
              {t('farmRecords.needsAnswer')}
            </Alert>
          )}
          {error != null && <Alert tone="danger">{errorMessage(error)}</Alert>}
          {!allowed && <p className="text-sm text-muted-foreground">{t('farmRecords.noPermission')}</p>}

          <div className="flex flex-col gap-2">
            {canConfirm && (
              <Button size="lg" className="w-full" loading={confirm.isPending} disabled={busy} onClick={onConfirm} data-testid="farm-proposal-confirm">
                <Check aria-hidden />
                {t('records.actions.confirm')}
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              loading={reject.isPending}
              disabled={busy}
              onClick={() => reject.mutate()}
              data-testid="farm-proposal-cancel"
            >
              <X aria-hidden />
              {t('records.actions.cancel')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('farmRecords.expires', { time: formatDateTime(proposal.expiresAt) })}</p>
          </div>
        </>
      )}

      {!isPending && (
        <>
          {error != null && <Alert tone="danger">{errorMessage(error)}</Alert>}
          <Outcome proposal={proposal} onUndo={() => undo.mutate()} undoing={undo.isPending} />
        </>
      )}
    </section>
  );
}
