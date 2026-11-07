import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { useCenterName, useLocalName } from '@/features/finance/lib';
import type { CategoryOption, CostCenterOption } from '@/features/finance/types';
import { currencyLabel, formatDate, formatMoney, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { expectsAnswer, questionKeys } from './proposals';
import type { Question, QuestionOption } from './types';

const AMOUNT_FIELDS = new Set(['amount', 'unitPrice']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An option in the person's language. The API sends some labels in English ("we paid"), or only as
 * stored ("General", Uzbek category names), and the tapped text becomes their message.
 */
function useOptionLabel(question: Question): (option: QuestionOption) => string {
  const { t } = useTranslation('ai');
  const localName = useLocalName();
  const centerName = useCenterName();
  const categories = useDetail<CategoryOption[]>(question.field === 'category' ? '/finance/categories' : null).data;
  const centers = useDetail<CostCenterOption[]>(question.field === 'target' ? '/finance/cost-centers/lookup' : null).data;

  return (option) => {
    const number = Number(option.id);
    if (AMOUNT_FIELDS.has(question.field) && Number.isFinite(number)) return formatMoney(number);
    if (question.field === 'fxRate' && Number.isFinite(number)) return formatNumber(number, 4);
    if (question.field === 'date' && ISO_DATE.test(option.id)) return formatDate(option.id);
    const category = question.field === 'category' ? categories?.find((c) => c.id === option.id) : undefined;
    if (category) return localName(category.name);
    const center = question.field === 'target' ? centers?.find((c) => c.id === option.id) : undefined;
    if (center) return centerName(center.name, center.type);
    if (question.field === 'paymentMethod') return t(`enums:paymentMethod.${option.id}`, { defaultValue: option.label });
    if (question.field === 'direction') return t(`records.direction.${option.id}`, { defaultValue: option.label });
    // Wordings such as "wage" or "per_ton". A stored name is its own label.
    return t(`records.options.${option.id}`, { defaultValue: option.label });
  };
}

/** Choices as large tap targets: answering in the field should not need typing. */
export function QuestionOptions({
  question,
  onAnswer,
  disabled,
}: {
  question: Question;
  onAnswer: (option: QuestionOption, label: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('ai');
  const labelOf = useOptionLabel(question);
  if (question.options.length === 0) return null;
  return (
    <div role="group" aria-label={t('records.question.choose')} className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-testid="question-options">
      {question.options.map((option) => {
        const label = labelOf(option);
        return (
          <Button
            key={option.id}
            variant="outline"
            className="h-auto min-h-11 justify-start py-2 text-left whitespace-normal"
            disabled={disabled}
            onClick={() => onAnswer(option, label)}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

/** A question in words, with its options when they can be used here. Never depends on there being any. */
export function QuestionPrompt({
  question,
  onAnswer,
  disabled,
  note,
}: {
  question: Question;
  /** Left out when these options cannot be used here. */
  onAnswer?: (option: QuestionOption, label: string) => void;
  disabled?: boolean;
  note?: string;
}) {
  const { t } = useTranslation('ai');
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3 text-secondary-foreground" data-testid="proposal-question" data-code={question.code}>
      <p className="flex items-start gap-2 font-medium">
        <Bot className="mt-0.5 size-5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{t(questionKeys(question), { base: currencyLabel() })}</span>
      </p>
      {onAnswer && <QuestionOptions question={question} onAnswer={onAnswer} disabled={disabled} />}
      {note && <p className="text-sm">{note}</p>}
    </div>
  );
}

/**
 * The question standing in a chat. The message above already asks it, so options alone are enough.
 * With no options there is nothing to tap, so it is said in words and points to the box below.
 */
export function ChatQuestion({
  question,
  onAnswer,
  disabled,
}: {
  question: Question;
  /** Left out when an answer cannot be sent right now: the options stay, but cannot be tapped. */
  onAnswer?: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('ai');
  return (
    <div data-testid="chat-question" data-code={question.code}>
      {question.options.length > 0 ? (
        <QuestionOptions question={question} disabled={disabled || !onAnswer} onAnswer={(_option, label) => onAnswer?.(label)} />
      ) : (
        <QuestionPrompt question={question} note={onAnswer && expectsAnswer(question) ? t('records.question.typeAnswer') : undefined} />
      )}
    </div>
  );
}
