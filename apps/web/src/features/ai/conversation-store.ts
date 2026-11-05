import { useCallback, useMemo } from 'react';
import { useSession } from '@/lib/auth';
import { storageGet, storageSet } from '@/lib/utils';

/**
 * The conversation last used on this device, per user and farm. The /ai page and the floating
 * sheet share it, so a chat started in one continues in the other.
 */
export function useLastConversation() {
  const session = useSession();
  const key = `yap.ai.conversation.${session.user.id}.${session.farm?.id ?? ''}`;
  const read = useCallback(() => storageGet(key) ?? '', [key]);
  const write = useCallback((id: string) => storageSet(key, id), [key]);
  return useMemo(() => ({ read, write }), [read, write]);
}
