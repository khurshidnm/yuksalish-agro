import { cn } from '@/lib/utils';

/** A sprout rising from a hill: "yuksalish" is growth. Theme tokens keep it right in both modes. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-9 shrink-0', className)}>
      <rect width="32" height="32" rx="9" className="fill-accent" />
      <path d="M0 22.8C4.6 20 10.1 18.6 16 18.6s11.4 1.4 16 4.2v.2a9 9 0 0 1-9 9H9a9 9 0 0 1-9-9z" className="fill-accent-foreground" />
      <path d="M16 19.5V11.5" className="stroke-accent-foreground" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 14.4C15.7 10.4 12.7 7.8 7.6 7.6c.1 4.8 3.2 7.5 8.4 6.8zM16 11.8c.3-3.9 3.1-6.4 8.4-6.7.1 5-2.8 7.6-8.4 6.7z" className="fill-accent-foreground" />
    </svg>
  );
}
