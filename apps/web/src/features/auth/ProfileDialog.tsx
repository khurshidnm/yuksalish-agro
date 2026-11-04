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
import { ROLES_REQUIRING_2FA } from '@yap/shared';

const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

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
  const { user, role, farm } = session;
  const mandatory = (ROLES_REQUIRING_2FA as readonly string[]).includes(role?.key ?? '');

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
    </>
  );
}
