import { ShieldCheck, ShieldOff } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { FormDialog } from '@/components/FormDialog';
import { TextField } from '@/components/FormField';
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Separator } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import type { RecoveryCodesResult } from '@/lib/types';
import { ROLES_REQUIRING_2FA } from '@yap/shared';
import { RecoveryCodes } from './RecoveryCodes';

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  );
}

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const { reloadSession } = useAuth();
  const [disableOpen, setDisableOpen] = useState(false);
  const [newCodesOpen, setNewCodesOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { user, role, farm } = session;
  const mandatory = user.isPlatformAdmin || (ROLES_REQUIRING_2FA as readonly string[]).includes(role?.key ?? '');

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{user.fullName}</DialogTitle>
            <DialogDescription>{t('auth:profile.title')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <dl>
              <Row label={t('auth:profile.phone')}>{user.phone}</Row>
              {user.email && <Row label={t('auth:profile.email')}>{user.email}</Row>}
              {role && <Row label={t('auth:profile.role')}>{t(`enums:role.${role.key}`, { defaultValue: role.name })}</Row>}
              {farm && <Row label={t('auth:profile.farm')}>{farm.name}</Row>}
            </dl>
            <Separator className="my-2" />
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="min-w-0 text-sm">
                <p className="font-medium">{t('auth:profile.twoFactor')}</p>
                <Badge variant={user.totpEnabled ? 'success' : 'warning'} className="mt-1">
                  {user.totpEnabled ? <ShieldCheck aria-hidden /> : <ShieldOff aria-hidden />}
                  {user.totpEnabled ? t('auth:profile.on') : t('auth:profile.off')}
                </Badge>
              </div>
              {user.totpEnabled ? (
                !mandatory && (
                  <Button variant="outline" onClick={() => setDisableOpen(true)}>
                    {t('auth:twoFactor.disable')}
                  </Button>
                )
              ) : (
                <Button asChild variant="secondary">
                  <Link to="/2fa/setup" onClick={() => onOpenChange(false)}>
                    {t('auth:profile.setup')}
                  </Link>
                </Button>
              )}
            </div>
            {user.totpEnabled && (
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">{t('auth:twoFactor.recoveryLeft', { count: user.recoveryCodesLeft ?? 0 })}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setNewCodesOpen(true)}>
                    {t('auth:twoFactor.newCodes')}
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/2fa/setup?replace" onClick={() => onOpenChange(false)}>
                      {t('auth:twoFactor.replace')}
                    </Link>
                  </Button>
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FormDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title={t('auth:twoFactor.disable')}
        description={t('auth:twoFactor.disableHint')}
        schema={codeSchema}
        size="sm"
        defaultValues={{ code: '' }}
        submitLabel={t('auth:twoFactor.disable')}
        successMessage="auth:twoFactor.disabled"
        onSubmit={async ({ code }) => {
          await api.post('/auth/2fa/disable', { code });
          await reloadSession();
        }}
      >
        {(form) => <TextField form={form} name="code" label={t('auth:twoFactor.code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />}
      </FormDialog>

      <FormDialog
        open={newCodesOpen}
        onOpenChange={setNewCodesOpen}
        title={t('auth:twoFactor.newCodes')}
        description={t('auth:twoFactor.newCodesHint')}
        schema={codeSchema}
        size="sm"
        defaultValues={{ code: '' }}
        submitLabel={t('auth:twoFactor.newCodes')}
        onSubmit={async ({ code }) => {
          const result = await api.post<RecoveryCodesResult>('/auth/2fa/recovery-codes', { code });
          setCodes(result.recoveryCodes);
        }}
      >
        {(form) => <TextField form={form} name="code" label={t('auth:twoFactor.replaceCode')} autoComplete="one-time-code" maxLength={32} />}
      </FormDialog>

      <Dialog open={codes !== null}>
        <DialogContent size="sm" hideClose onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('auth:twoFactor.recoveryTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{t('auth:twoFactor.recoveryTitle')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <RecoveryCodes
              codes={codes ?? []}
              onDone={() => {
                setCodes(null);
                void reloadSession();
              }}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
