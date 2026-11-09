import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui';

export interface MoreAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  hidden?: boolean;
  destructive?: boolean;
}

/**
 * The less used actions of a card page, behind one "…" button. Five or six buttons in a header
 * squeeze the title to a letter per line on a laptop and fill half a phone screen.
 */
export function MoreActions({ actions }: { actions: MoreAction[] }) {
  const { t } = useTranslation();
  const shown = actions.filter((action) => !action.hidden);
  if (shown.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('common:actions.more')}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {shown.map((action) => (
          <DropdownMenuItem key={action.label} destructive={action.destructive} onSelect={action.onSelect}>
            <action.icon aria-hidden />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
