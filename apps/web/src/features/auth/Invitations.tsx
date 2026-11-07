import { Building2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/query';
import type { Invitation } from '@/lib/types';

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const { t } = useTranslation();
  const { acceptInvitation, reloadSession } = useAuth();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  const answer = async (choice: 'accept' | 'decline') => {
    setBusy(choice);
    try {
      if (choice === 'accept') await acceptInvitation(invitation.id);
      else {
        await api.post(`/auth/invitations/${invitation.id}/decline`);
        await reloadSession();
      }
      toast.success(t(choice === 'accept' ? 'auth:invitations.accepted' : 'auth:invitations.declined'));
    } catch (cause) {
      toast.error(errorMessage(cause));
      setBusy(null);
    }
  };

  return (
    <li className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-2 font-medium break-words">
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {invitation.tenantName}
      </p>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {invitation.farmName} · {t(`enums:role.${invitation.roleKey}`, { defaultValue: invitation.roleName })}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="outline" loading={busy === 'decline'} disabled={busy !== null} onClick={() => void answer('decline')}>
          {t('auth:invitations.decline')}
        </Button>
        <Button loading={busy === 'accept'} disabled={busy !== null} onClick={() => void answer('accept')}>
          {t('auth:invitations.accept')}
        </Button>
      </div>
    </li>
  );
}

/** For someone with no farm yet, this is the whole screen they can act on. */
export function InvitationList() {
  const { t } = useTranslation();
  const { invitations } = useSession();
  return (
    <div>
      <h2 className="font-semibold">{t('auth:invitations.title')}</h2>
      <p className="mt-1 mb-3 text-sm text-muted-foreground">{t('auth:invitations.intro')}</p>
      <ul className="flex flex-col gap-2">
        {invitations.map((invitation) => (
          <InvitationRow key={invitation.id} invitation={invitation} />
        ))}
      </ul>
    </div>
  );
}

/** Someone already at work gets asked once per visit, and it comes back the next time the app opens. */
export function InvitationsDialog() {
  const { t } = useTranslation();
  const { invitations } = useSession();
  const [later, setLater] = useState(false);

  return (
    <Dialog open={invitations.length > 0 && !later} onOpenChange={(open) => !open && setLater(true)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('auth:invitations.title')}</DialogTitle>
          <DialogDescription>{t('auth:invitations.intro')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} />
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setLater(true)}>
            {t('auth:invitations.later')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
