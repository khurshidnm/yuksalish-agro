import { Check, Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, Button, Checkbox, Label } from '@/components/ui';

/**
 * The only moment these codes are readable, so the way on stays shut until the person says they
 * have them. Without them, a lost phone means asking someone else to let them back in.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = [t('auth:twoFactor.recoveryFile'), '', ...codes, ''].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error(t('auth:twoFactor.recoveryCopyFailed'));
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'yuksalish-agro-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning">{t('auth:twoFactor.recoveryBody')}</Alert>
      <ol className="grid gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted p-3 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code} className="break-all select-all">
            {code}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => void copy()}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('auth:twoFactor.recoveryCopied') : t('auth:twoFactor.recoveryCopy')}
        </Button>
        <Button variant="outline" onClick={download}>
          <Download aria-hidden />
          {t('auth:twoFactor.recoveryDownload')}
        </Button>
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox id="recovery-saved" checked={saved} onCheckedChange={(value) => setSaved(value === true)} />
        <Label htmlFor="recovery-saved">{t('auth:twoFactor.recoverySaved')}</Label>
      </div>
      <Button size="lg" disabled={!saved} onClick={onDone}>
        {t('auth:twoFactor.recoveryContinue')}
      </Button>
    </div>
  );
}
