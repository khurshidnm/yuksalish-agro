import { Check, ExternalLink, Pencil, Send, Undo2, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Badge, Button } from '@/components/ui';
import { useCenterName, useLocalName } from '@/features/finance/lib';
import { useCan, useSession } from '@/lib/auth';
import { currencyLabel, formatDate, formatDateTime, formatMoney, formatNumber, formatQty } from '@/lib/format';
import { errorMessage } from '@/lib/query';
import { ProposalEditDialog, type ProposalFormValues } from './ProposalEditDialog';
import {
  type Notice,
  acknowledgeBodyKey,
  acknowledgeYesKey,
  afterRefusal,
  answerAsChange,
  answerableOnCard,
  awaitsApproval,
  canActOn,
  categoryLabel,
  changesNotApplied,
  clockText,
  listedWarnings,
  needsYes,
  readRefusal,
  recordLink,
  refusedInBooks,
  undoSecondsLeft,
  warningKeys,
} from './proposals';
import { QuestionPrompt } from './QuestionOptions';
import type { ProposalFields, ProposalView, ProposalWarning, Question } from './types';
import { type ProposalChanges, asksQuestions, useProposal } from './useProposal';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{children}</dd>
    </>
  );
}

function Details({ proposal }: { proposal: ProposalView }) {
  const { t } = useTranslation('ai');
  const localName = useLocalName();
  const centerName = useCenterName();
  const { fields, kind, masked } = proposal;
  // How it was paid and who paid whom are finance data too, so a masked card leaves them out.
  const payment = masked ? null : (fields.account?.name ?? (fields.paymentMethod ? t(`enums:paymentMethod.${fields.paymentMethod}`) : null));

  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {fields.direction && !masked && (
        <Row label={t('records.fields.direction')}>
          <span data-testid="proposal-direction">{t(`records.direction.${fields.direction}`)}</span>
        </Row>
      )}
      {fields.category && <Row label={t('records.fields.category')}>{categoryLabel(fields.category, localName)}</Row>}
      {fields.target && (
        <Row label={t('records.fields.target')}>
          {centerName(fields.target.name, fields.target.type)}
          {fields.target.defaulted && (
            <span className="mt-0.5 block text-sm font-normal text-warning" data-testid="target-defaulted">
              {t('records.card.targetDefaulted')}
            </span>
          )}
        </Row>
      )}
      {fields.item && <Row label={t('records.fields.item')}>{fields.item.name}</Row>}
      {fields.qty != null && <Row label={t('records.fields.qty')}>{formatQty(fields.qty, fields.item?.unit)}</Row>}
      {fields.unitPrice != null && <Row label={t('records.fields.unitPrice')}>{formatMoney(fields.unitPrice, { currency: fields.currency })}</Row>}
      {fields.warehouse && <Row label={t('records.fields.warehouse')}>{fields.warehouse.name}</Row>}
      {kind === 'transfer' ? (
        <>
          {fields.account && <Row label={t('records.fields.fromAccount')}>{fields.account.name}</Row>}
          {fields.toAccount && <Row label={t('records.fields.toAccount')}>{fields.toAccount.name}</Row>}
        </>
      ) : (
        payment && <Row label={t('records.fields.account')}>{payment}</Row>
      )}
      {fields.date && <Row label={t('records.fields.date')}>{formatDate(fields.date)}</Row>}
      {fields.counterparty && <Row label={t('records.fields.counterparty')}>{fields.counterparty.name}</Row>}
    </dl>
  );
}

/** The amount first, then what it comes to in the farm's currency when it is another one. */
function Amount({ fields }: { fields: ProposalFields }) {
  const { t } = useTranslation('ai');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';
  const foreign = fields.fxRate !== null && fields.currency !== baseCurrency;
  return (
    <div className="min-w-0">
      <p className="text-3xl leading-tight font-bold break-words tabular-nums" data-testid="proposal-amount">
        {formatMoney(fields.amount, { currency: fields.currency })}
      </p>
      {foreign && (
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="proposal-rate">
          ≈ {formatMoney(fields.amountBase, { currency: baseCurrency })} ·{' '}
          {t('records.card.fxRate', { currency: currencyLabel(fields.currency), rate: formatNumber(fields.fxRate, 4), base: currencyLabel(baseCurrency) })}
        </p>
      )}
    </div>
  );
}

/** Warning params as the text shows them. Amounts the message left out carry no currency of their own. */
function warningValues({ params }: ProposalWarning, fields: ProposalFields): Record<string, unknown> {
  const amounts = Array.isArray(params.amounts) ? (params.amounts as number[]) : [];
  return {
    ...params,
    amount: formatMoney(params.amount as number | undefined, { currency: fields.currency }),
    amounts: amounts.map((amount) => formatNumber(amount)).join(', '),
    balance: formatNumber(params.balance as number | undefined),
    currency: currencyLabel(params.currency as string | undefined),
    date: formatDate(params.date as string | undefined),
    median: formatMoney(params.median as number | undefined),
    rate: formatNumber(params.rate as number | undefined, 4),
  };
}

function WarningAlert({ warning, fields }: { warning: ProposalWarning; fields: ProposalFields }) {
  const { t } = useTranslation('ai');
  const values = warningValues(warning, fields);
  if (needsYes(warning)) {
    return (
      <Alert tone="warning" title={t(`records.acknowledge.${warning.code}.title`)} data-testid={`warning-${warning.code}`}>
        {t(acknowledgeBodyKey(warning), values)}
      </Alert>
    );
  }
  return (
    <Alert tone="warning" data-testid={`warning-${warning.code}`}>
      {t(warningKeys(warning), values)}
    </Alert>
  );
}

function Warnings({ proposal }: { proposal: ProposalView }) {
  const warnings = listedWarnings(proposal);
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="proposal-warnings">
      {warnings.map((warning, i) => (
        <WarningAlert key={i} warning={warning} fields={proposal.fields} />
      ))}
    </div>
  );
}

function Learning({ proposal }: { proposal: ProposalView }) {
  const { t } = useTranslation('ai');
  if (proposal.learning.length === 0) return null;
  return (
    <Alert tone="info" title={t('records.card.learningTitle')} data-testid="proposal-learning">
      <ul className="flex flex-col gap-0.5">
        {proposal.learning.map(({ phrase, name }) => (
          <li key={phrase} className="font-medium break-words">
            {t('records.card.learning', { phrase, name })}
          </li>
        ))}
      </ul>
      <p className="mt-1">{t('records.card.learningBody')}</p>
    </Alert>
  );
}

function NoticeAlert({ notice }: { notice: Notice }) {
  const { t } = useTranslation('ai');
  if (notice.code === 'PROPOSAL_CHANGED') {
    const names = notice.rows.map((row) => t(`records.fields.${row}`)).join(', ');
    return (
      <Alert tone="warning" title={t('records.notice.changedTitle')} data-testid="proposal-changed">
        {notice.rows.length > 0 ? t('records.notice.changed', { fields: names }) : t('records.notice.changedUnnamed')}
      </Alert>
    );
  }
  if (notice.code === 'PROPOSAL_STALE') {
    return (
      <Alert tone="warning" title={t('records.notice.staleTitle')} data-testid="proposal-stale">
        {t('records.notice.stale')}
      </Alert>
    );
  }
  return null;
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

function Outcome({ proposal, canUndo, onUndo, undoing }: { proposal: ProposalView; canUndo: boolean; onUndo: () => void; undoing: boolean }) {
  const { t } = useTranslation('ai');
  const can = useCan();
  const confirmed = proposal.status === 'confirmed';
  const left = useSecondsLeft(confirmed && canUndo ? proposal.undoUntil : null);
  const link = confirmed && !proposal.masked ? recordLink(proposal.result, proposal.fields.date, can) : null;

  return (
    <div className="flex flex-col gap-2" data-testid="proposal-outcome">
      {confirmed &&
        (refusedInBooks(proposal) ? (
          <Alert tone="danger" title={t('records.outcome.refusedTitle')} data-testid="proposal-refused">
            {t('records.outcome.refusedBody')}
          </Alert>
        ) : awaitsApproval(proposal) ? (
          <Alert tone="warning" title={t('records.outcome.waitingTitle')}>
            {t('records.outcome.waitingBody')}
          </Alert>
        ) : (
          <Alert tone="success" title={t('records.outcome.confirmedTitle')} />
        ))}
      {proposal.status === 'failed' && (
        <Alert tone="danger" title={t('records.outcome.failedTitle')}>
          {t('records.outcome.failedBody')}
        </Alert>
      )}
      {(proposal.status === 'rejected' || proposal.status === 'expired' || proposal.status === 'undone') && (
        <Alert tone="info" title={t(`records.outcome.${proposal.status}Title`)}>
          {t(`records.outcome.${proposal.status}Body`)}
        </Alert>
      )}
      {(left > 0 || link) && (
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {left > 0 && (
            <Button variant="outline" loading={undoing} onClick={onUndo} data-testid="proposal-undo">
              <Undo2 aria-hidden />
              {t('records.actions.undo', { time: clockText(left) })}
            </Button>
          )}
          {link && (
            <Button asChild variant="outline">
              <Link to={link} data-testid="proposal-link">
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

/** A change the server answered with a question. Nothing was saved, so an answer resends all of it. */
interface PendingChange {
  changes: ProposalChanges;
  values?: ProposalFormValues;
  questions: Question[];
}

/** A prepared record, laid out to be checked in seconds: the amount first, then where it goes. */
export function ProposalCard({ proposal: snapshot }: { proposal: ProposalView }) {
  const { t } = useTranslation('ai');
  const can = useCan();
  const { proposal, confirm, reject, undo, update } = useProposal(snapshot);
  const [editing, setEditing] = useState(false);
  // The stamp the explicit yes was asked for: a card that changes needs reading again.
  const [askedYesFor, setAskedYesFor] = useState<string | null>(null);
  const [asked, setAsked] = useState<PendingChange | null>(null);
  const [notApplied, setNotApplied] = useState<string[]>([]);
  const [refused, setRefused] = useState<Notice | null>(null);

  const { masked } = proposal;
  const isPending = proposal.status === 'pending';
  const allowed = canActOn(proposal, can);
  const error = confirm.error ?? reject.error ?? undo.error ?? (editing ? null : update.error);
  const busy = confirm.isPending || reject.isPending || update.isPending;

  const notice = refused?.stamp === proposal.stamp ? refused : null;
  const stale = notice?.code === 'PROPOSAL_STALE';
  const awaitingAnswer = proposal.needsAnswer || notice?.code === 'PROPOSAL_NEEDS_ANSWER';
  const canConfirm = allowed && !stale && !awaitingAnswer;
  const acknowledging = canConfirm && askedYesFor === proposal.stamp && proposal.needsAcknowledgement;
  const question = asked?.questions[0] ?? (notice?.code === 'PROPOSAL_STALE' ? notice.questions[0] : undefined) ?? null;

  const onConfirm = () => {
    if (proposal.needsAcknowledgement && !acknowledging) {
      setAskedYesFor(proposal.stamp);
      return;
    }
    const read = proposal;
    confirm.mutate(acknowledging ? { stamp: read.stamp, acknowledged: true } : { stamp: read.stamp }, {
      onError: (failure) => {
        const refusal = readRefusal(failure);
        if (!refusal) return;
        // The card itself now says what happened, so the bare error would only repeat it.
        confirm.reset();
        const next = afterRefusal(refusal, read);
        setRefused(next.notice);
        setAskedYesFor(next.askYesFor);
      },
    });
  };

  const save = async (changes: ProposalChanges, values?: ProposalFormValues) => {
    confirm.reset();
    const result = await update.mutateAsync(changes);
    const questions = asksQuestions(result);
    setAsked(questions ? { changes, values, questions: result.questions } : null);
    setNotApplied(questions ? [] : changesNotApplied(changes, result.fields));
    if (questions) return;
    setRefused(null);
    setAskedYesFor(null);
  };

  return (
    <section
      aria-label={t(`records.kind.${proposal.kind}`)}
      data-testid="proposal-card"
      data-status={proposal.status}
      className="flex w-full max-w-xl min-w-0 flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:p-4"
    >
      {masked ? (
        <p className="text-sm text-muted-foreground" data-testid="proposal-masked">
          {t('records.card.masked')}
        </p>
      ) : (
        <Amount fields={proposal.fields} />
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="info">{t(`records.kind.${proposal.kind}`)}</Badge>
        {proposal.channel === 'telegram' && (
          <Badge variant="outline">
            <Send aria-hidden />
            {t('records.channel.telegram')}
          </Badge>
        )}
      </div>
      {proposal.fields.description && !masked && <p className="line-clamp-2 font-medium break-words">{proposal.fields.description}</p>}

      <Details proposal={proposal} />

      {isPending && !masked && (
        <>
          <Learning proposal={proposal} />
          <Warnings proposal={proposal} />
          {proposal.willNeedApproval && <Alert tone="warning">{t('records.card.willNeedApproval')}</Alert>}
          {notice && <NoticeAlert notice={notice} />}
          {awaitingAnswer && (
            <Alert tone="warning" title={t('records.notice.needsAnswerTitle')} data-testid="proposal-needs-answer">
              {t('records.notice.needsAnswer')}
            </Alert>
          )}
          {notApplied.length > 0 && (
            <Alert tone="danger" data-testid="proposal-not-applied">
              {t('records.card.notApplied', { fields: notApplied.map((field) => t(`records.fields.${field}`)).join(', ') })}
            </Alert>
          )}
          {error != null && <Alert tone="danger">{errorMessage(error)}</Alert>}
          {!allowed && <p className="text-sm text-muted-foreground">{t('records.card.noPermission')}</p>}
          {question && (
            <QuestionPrompt
              question={question}
              disabled={busy}
              note={asked ? t('records.question.notSaved') : undefined}
              onAnswer={
                allowed && answerableOnCard(question)
                  ? (option) => {
                      save({ ...asked?.changes, ...answerAsChange(question, option.id) }, asked?.values).catch(() => undefined);
                    }
                  : undefined
              }
            />
          )}
        </>
      )}

      {isPending && !masked && asked && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil aria-hidden />
            {t('records.actions.change')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setAsked(null)} data-testid="proposal-question-back">
            {t('records.actions.back')}
          </Button>
        </div>
      )}

      {/* Back sits where Confirm was, so a double tap on Confirm can never land on the yes. */}
      {isPending && !masked && !asked && acknowledging && (
        <div className="flex flex-col gap-2" data-testid="proposal-acknowledge-step">
          <Button variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => setAskedYesFor(null)}>
            {t('records.actions.back')}
          </Button>
          <Button
            size="lg"
            variant="accent"
            className="h-auto min-h-12 w-full py-2 whitespace-normal"
            loading={confirm.isPending}
            onClick={onConfirm}
            data-testid="proposal-acknowledge-yes"
          >
            <Check aria-hidden />
            {t(acknowledgeYesKey(proposal))}
          </Button>
        </div>
      )}

      {isPending && !masked && !asked && !acknowledging && (
        <div className="flex flex-col gap-2">
          {canConfirm && (
            <Button size="lg" className="w-full" loading={confirm.isPending} disabled={busy} onClick={onConfirm} data-testid="proposal-confirm">
              <Check aria-hidden />
              {t('records.actions.confirm')}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            {allowed && (
              <Button variant="outline" disabled={busy} onClick={() => setEditing(true)} data-testid="proposal-change">
                <Pencil aria-hidden />
                {t('records.actions.change')}
              </Button>
            )}
            <Button
              variant="outline"
              className={allowed ? undefined : 'col-span-2'}
              loading={reject.isPending}
              disabled={busy}
              onClick={() => reject.mutate()}
              data-testid="proposal-cancel"
            >
              <X aria-hidden />
              {t('records.actions.cancel')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('records.card.expires', { time: formatDateTime(proposal.expiresAt) })}</p>
        </div>
      )}

      {!isPending && (
        <>
          {error != null && <Alert tone="danger">{errorMessage(error)}</Alert>}
          <Outcome proposal={proposal} canUndo={allowed} onUndo={() => undo.mutate()} undoing={undo.isPending} />
        </>
      )}

      {allowed && (
        <ProposalEditDialog proposal={proposal} open={editing} onOpenChange={setEditing} values={asked?.values} recheck={stale} onSave={save} />
      )}
    </section>
  );
}
