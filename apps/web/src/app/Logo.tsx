import { cn } from '@/lib/utils';

/** A wheat ear, drawn with theme tokens so it sits on the sidebar and on light surfaces alike. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-9 shrink-0', className)}>
      <rect width="32" height="32" rx="7" className="fill-sidebar-active" />
      <path d="M16 25V11" className="stroke-sidebar-active-foreground" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M16 15c-4-.2-6.2-2.4-6.6-6.4 4 .3 6.3 2.4 6.6 6.4zM16 15c4-.2 6.2-2.4 6.6-6.4-4 .3-6.3 2.4-6.6 6.4zM16 21c-4-.2-6.2-2.4-6.6-6.4 4 .3 6.3 2.4 6.6 6.4zM16 21c4-.2 6.2-2.4 6.6-6.4-4 .3-6.3 2.4-6.6 6.4z"
        className="fill-sidebar-active-foreground"
      />
    </svg>
  );
}
