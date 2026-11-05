import { Bell, Bot, Check, Copy, ExternalLink, Link2Off, Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorCard, useConfirm } from '@/components';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import type { Preferences, TelegramLink, TelegramStatus } from './types';

const PREFERENCES = '/notifications/preferences';
const TELEGRAM = '/notifications/telegram';

interface TestPerson {
  userId: string;
  /** Null without pii.view. */
  name: string | null;
  role: string;
}

interface TestResult {
  reached: TestPerson[];
  unreachable: (TestPerson & { reason: string })[];
}

function ChannelMatrix() {
  const { t } = useTranslation('alerts');
  const confirm = useConfirm();
  const { data, isLoading, error, refetch } = useDetail<Preferences>(PREFERENCES);

  const save = useApiMutation<{ eventType: string; channels: string[] }>({
    mutationFn: (body) => api.put(PREFERENCES, body),
    invalidate: [PREFERENCES],
    successMessage: 'common:toast.updated',
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const toggle = async (eventType: string, current: string[], channel: string, on: boolean) => {
    if (eventType === 'alert_urgent' && channel === 'telegram' && !on) {
      const ok = await confirm({
        title: t('settings.urgentOffTitle'),
        description: t('settings.urgentOffBody'),
        confirmLabel: t('settings.urgentOffConfirm'),
        destructive: true,
      });
      if (!ok) return;
    }
    save.mutate({ eventType, channels: on ? [...current, channel] : current.filter((c) => c !== channel) });
  };

  const telegramWorks = data.channels.some((channel) => channel.key === 'telegram' && channel.configured);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.channelsTitle')}</CardTitle>
        <CardDescription>{t('settings.channelsBody')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.events.map((event) => (
          <fieldset key={event.eventType} className="rounded-lg border border-border p-3">
            <legend className="px-1 font-medium">{t(`settings.event.${event.eventType}`)}</legend>
            <div className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <label className="flex min-h-11 items-center gap-3 text-sm text-muted-foreground">
                <Checkbox checked disabled />
                {t('enums:notificationChannel.in_app')}
              </label>
              {data.channels.map((channel) => (
                <label key={channel.key} className="flex min-h-11 items-center gap-3 text-sm">
                  <Checkbox
                    checked={event.channels.includes(channel.key)}
                    disabled={!channel.configured || save.isPending}
                    onCheckedChange={(on) => void toggle(event.eventType, event.channels, channel.key, on === true)}
                  />
                  <span className={channel.configured ? undefined : 'text-muted-foreground'}>
                    {t(`enums:notificationChannel.${channel.key}`)}
                  </span>
                  {!channel.configured && <Badge variant="outline">{t('settings.notConfigured')}</Badge>}
                </label>
              ))}
            </div>
            {event.eventType === 'alert_urgent' && telegramWorks && !event.channels.includes('telegram') && (
              <Alert tone="warning" className="mt-2">
                {t('settings.urgentOff')}
              </Alert>
            )}
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

function TelegramCard() {
  const { t } = useTranslation('alerts');
  const confirm = useConfirm();
  const [link, setLink] = useState<TelegramLink | null>(null);

  // While a code is out, watch for the bot confirming it.
  const status = useDetail<TelegramStatus>(TELEGRAM, undefined, {
    refetchInterval: (query) => (link && !query.state.data?.linked ? 4000 : false),
  });

  const start = useApiMutation<void, TelegramLink>({
    mutationFn: () => api.post(`${TELEGRAM}/link`),
    onSuccess: setLink,
  });
  const unlink = useApiMutation<void>({
    mutationFn: () => api.delete(TELEGRAM),
    invalidate: [TELEGRAM],
    successMessage: 'alerts:toast.unlinked',
    onSuccess: () => setLink(null),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('telegram.copied'));
    } catch {
      toast.error(t('telegram.copyFailed'));
    }
  };

  if (status.isLoading) return <Skeleton className="h-40 w-full" />;
  if (status.error) return <ErrorCard error={status.error} onRetry={() => void status.refetch()} />;
  const state = status.data;
  if (!state) return null;

  const command = link ? `/start ${link.code}` : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-5" aria-hidden />
          {t('telegram.title')}
        </CardTitle>
        <CardDescription>{t('telegram.body')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!state.configured && <Alert tone="info">{t('telegram.notConfigured')}</Alert>}

        {state.configured && state.linked && (
          <>
            <Alert tone="success">{t('telegram.linked')}</Alert>
            <Button
              variant="outline"
              loading={unlink.isPending}
              onClick={async () => {
                const ok = await confirm({ title: t('telegram.unlinkTitle'), description: t('telegram.unlinkBody'), destructive: true });
                if (ok) unlink.mutate();
              }}
            >
              <Link2Off aria-hidden />
              {t('telegram.unlink')}
            </Button>
          </>
        )}

        {state.configured && !state.linked && !link && (
          <Button loading={start.isPending} onClick={() => start.mutate()}>
            <Send aria-hidden />
            {t('telegram.link')}
          </Button>
        )}

        {state.configured && !state.linked && link && (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>{t('telegram.step1')}</li>
              <li>{t('telegram.step2')}</li>
            </ol>
            {link.deepLink && (
              <Button asChild>
                <a href={link.deepLink} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden />
                  {t('telegram.openBot')}
                </a>
              </Button>
            )}
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2.5 text-sm">{command}</code>
              <Button variant="outline" size="icon" aria-label={t('telegram.copy')} onClick={() => void copy(command)}>
                <Copy aria-hidden />
              </Button>
            </div>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Check className="size-4" aria-hidden />
              {t('telegram.waiting', { time: formatDateTime(link.expiresAt) })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TestAlertCard() {
  const { t } = useTranslation('alerts');
  const confirm = useConfirm();
  const [result, setResult] = useState<TestResult | null>(null);
  const send = useApiMutation<void, TestResult>({
    mutationFn: () => api.post('/alerts/test'),
    onSuccess: setResult,
  });
  const who = (person: TestPerson) => person.name ?? t(`enums:role.${person.role}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-5" aria-hidden />
          {t('testAlert.title')}
        </CardTitle>
        <CardDescription>{t('testAlert.body')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          variant="outline"
          loading={send.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: t('testAlert.confirmTitle'),
              description: t('testAlert.confirmBody'),
              confirmLabel: t('testAlert.confirmAction'),
            });
            if (ok) send.mutate();
          }}
        >
          <Send aria-hidden />
          {t('testAlert.send')}
        </Button>

        {result && result.reached.length + result.unreachable.length === 0 && <Alert tone="warning">{t('testAlert.nobody')}</Alert>}

        {result && result.reached.length > 0 && (
          <Alert tone="success" title={t('testAlert.reached', { count: result.reached.length })}>
            <ul className="space-y-1">
              {result.reached.map((person) => (
                <li key={person.userId}>{who(person)}</li>
              ))}
            </ul>
          </Alert>
        )}

        {result && result.unreachable.length > 0 && (
          <Alert tone="danger" title={t('testAlert.unreachable', { count: result.unreachable.length })}>
            <ul className="space-y-1">
              {result.unreachable.map((person) => (
                <li key={person.userId}>
                  <span className="block font-medium">{who(person)}</span>
                  {t(`testAlert.reason.${person.reason}`)}
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationSettings() {
  const canTest = usePermission('dashboard.update');
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <ChannelMatrix />
      <div className="grid grid-cols-1 gap-4">
        <TelegramCard />
        {canTest && <TestAlertCard />}
      </div>
    </div>
  );
}
