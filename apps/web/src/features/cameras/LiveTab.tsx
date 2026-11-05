import { ExternalLink, VideoOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Alert, Badge, Card, Skeleton } from '@/components/ui';
import { useList } from '@/lib/query';
import { DEVICES, type Device, STATUS_VARIANT } from './types';

/** Browsers play these directly. Any other address is a gateway's own player page. */
const isDirectMedia = (url: string) => /\.(m3u8|mp4|webm)(\?|#|$)/i.test(url);

/** An https page may not embed an http address, and a refused iframe stays blank with no error to catch. */
const refusedByBrowser = (url: string) => window.location.protocol === 'https:' && /^http:/i.test(url);

function Unavailable({ title, hint, url }: { title: string; hint: string; url?: string }) {
  const { t } = useTranslation('cameras');
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-1 bg-muted p-4 text-center">
      <VideoOff className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {url && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="focus-ring mt-1 inline-flex min-h-11 items-center gap-1 rounded text-sm text-primary underline-offset-4 hover:underline">
          <ExternalLink className="size-4" aria-hidden />
          {t('live.openStream')}
        </a>
      )}
    </div>
  );
}

/** Shows a real stream or says plainly why there is none. There is no placeholder video. */
function LiveTile({ device }: { device: Device }) {
  const { t } = useTranslation('cameras');
  const [failed, setFailed] = useState(false);

  let view;
  if (!device.liveUrl) {
    view = (
      <Unavailable
        title={t('live.notConfiguredTitle')}
        hint={device.status === 'planned' ? t('live.notInstalled') : t('live.notConfiguredHint')}
      />
    );
  } else if (refusedByBrowser(device.liveUrl)) {
    view = <Unavailable title={t('live.failedTitle')} hint={t('live.insecureHint')} url={device.liveUrl} />;
  } else if (failed) {
    view = <Unavailable title={t('live.failedTitle')} hint={t('live.failedHint')} url={device.liveUrl} />;
  } else if (isDirectMedia(device.liveUrl)) {
    view = (
      <video
        src={device.liveUrl}
        title={device.name}
        muted
        autoPlay
        playsInline
        controls
        onError={() => setFailed(true)}
        className="aspect-video w-full bg-muted"
      />
    );
  } else {
    view = <iframe src={device.liveUrl} title={device.name} sandbox="allow-scripts allow-same-origin" allow="autoplay" className="aspect-video w-full border-0 bg-muted" />;
  }

  return (
    <Card className="overflow-hidden p-0">
      {view}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium">{device.name}</span>
        <Badge variant={STATUS_VARIANT[device.status]}>{t(`enums:deviceStatus.${device.status}`)}</Badge>
      </div>
    </Card>
  );
}

export function LiveTab() {
  const { t } = useTranslation('cameras');
  const query = useList<Device>(DEVICES, { type: 'camera', pageSize: 32 });

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="aspect-video w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const cameras = query.data.data;
  if (cameras.length === 0) return <EmptyState icon={VideoOff} title={t('live.emptyTitle')} description={t('live.emptyBody')} />;

  return (
    <div className="flex flex-col gap-3">
      {!cameras.some((camera) => camera.liveUrl) && (
        <Alert tone="info" title={t('live.gatewayTitle')}>
          {t('live.gatewayBody')}
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cameras.map((camera) => (
          <LiveTile key={camera.id} device={camera} />
        ))}
      </div>
    </div>
  );
}
