import { Camera, LoaderCircle, LocateFixed, MapPin, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/query';

const MAX_PHOTOS = 10;
const MAX_SIDE_PX = 1600;

/**
 * Phones take 4-12 MB photos and the farm's connection is slow (spec 18.2), so shrink before
 * sending. If the browser cannot decode the file, send the original rather than lose the photo.
 */
async function compress(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export interface Photo {
  id: string;
  url: string;
}

export function PhotoCapture({ value, onChange }: { value: Photo[]; onChange: (photos: Photo[]) => void }) {
  const { t } = useTranslation('crops');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const added: Photo[] = [];
      for (const file of [...files].slice(0, MAX_PHOTOS - value.length)) {
        const uploaded = await api.upload(await compress(file));
        added.push({ id: uploaded.id, url: uploaded.url });
      }
      onChange([...value, ...added]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        aria-label={t('capture.addPhoto')}
        onChange={(e) => void add(e.target.files)}
      />
      {value.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {value.map((photo) => (
            <li key={photo.id} className="relative aspect-square overflow-hidden rounded-md border border-border">
              <img src={photo.url} alt="" className="size-full object-cover" />
              <button
                type="button"
                className="absolute top-1 right-1 grid size-11 place-items-center rounded-full bg-background/90 text-foreground shadow"
                aria-label={t('capture.removePhoto')}
                onClick={() => onChange(value.filter((p) => p.id !== photo.id))}
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < MAX_PHOTOS && (
        <Button type="button" variant="outline" size="lg" className="w-full" loading={busy} onClick={() => input.current?.click()}>
          <Camera aria-hidden />
          {t('capture.addPhoto')}
        </Button>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function GpsCapture({
  lat,
  lng,
  onChange,
}: {
  lat: number | null;
  lng: number | null;
  onChange: (point: { lat: number; lng: number } | null) => void;
}) {
  const { t } = useTranslation('crops');
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const locate = () => {
    if (!navigator.geolocation) {
      setProblem(t('capture.gpsUnavailable'));
      return;
    }
    setLocating(true);
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onChange({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        });
      },
      (failure) => {
        setLocating(false);
        setProblem(failure.code === failure.PERMISSION_DENIED ? t('capture.gpsDenied') : t('capture.gpsFailed'));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  if (lat !== null && lng !== null) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <MapPin className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate tabular-nums">
            {lat}, {lng}
          </span>
        </span>
        <Button type="button" variant="ghost" size="icon" aria-label={t('capture.clearGps')} onClick={() => onChange(null)}>
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="lg" className="w-full" disabled={locating} onClick={locate}>
        {locating ? <LoaderCircle className="animate-spin" aria-hidden /> : <LocateFixed aria-hidden />}
        {locating ? t('capture.locating') : t('capture.addGps')}
      </Button>
      {problem && <Alert tone="warning">{problem}</Alert>}
    </div>
  );
}
