import { cn } from '@/lib/utils';

/**
 * The AgroPanel mark: a panel of four tiles, one of them grown into a leaf. Both colours are tokens that stay
 * the same in light and dark. public/favicon.svg and the PNG icons draw the same shapes with fixed colours.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('size-9 shrink-0', className)}>
      <rect width="64" height="64" rx="15" className="fill-accent-foreground" />
      <g className="fill-accent">
        <rect x="11.5" y="11.5" width="18" height="18" rx="4" opacity=".42" />
        <rect x="11.5" y="34.5" width="18" height="18" rx="4" opacity=".42" />
        <rect x="34.5" y="34.5" width="18" height="18" rx="4" opacity=".42" />
        <path d="M53.5 10.5A20 20 0 0 0 33.5 30.5 20 20 0 0 0 53.5 10.5Z" />
      </g>
    </svg>
  );
}
