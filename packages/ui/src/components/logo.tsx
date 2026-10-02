import type { ComponentProps } from "react";
import { cn } from "#lib/utils"

export type LogoProps = Omit<ComponentProps<"span">, "children"> & {
  /** Height of the mark in px. The wordmark scales with it. */
  size?: number;
  wordmark?: boolean;
};

// At a 24px mark the wordmark is 21px with an 11px gap; both scale as em.
const WORDMARK_RATIO = 21 / 24;

export function Logo({
  size = 24,
  wordmark = true,
  className,
  style,
  ...props
}: LogoProps) {
  return (
    <span
      role="img"
      aria-label="gitflare"
      className={cn("inline-flex items-center gap-[0.524em]", className)}
      style={{ fontSize: size * WORDMARK_RATIO, ...style }}
      {...props}
    >
      <svg
        viewBox="11 9 42 21"
        width={size * 2}
        height={size}
        aria-hidden="true"
        className="shrink-0 fill-flare on-flare:fill-on-flare"
      >
        <circle cx="15.5" cy="25.5" r="4.5" />
        <circle cx="27" cy="22" r="8" />
        <circle cx="42.5" cy="19.5" r="10.5" />
        <rect x="15.5" y="24" width="27" height="6" />
      </svg>
      {wordmark && (
        <span
          aria-hidden="true"
          className="font-display font-bold leading-[1.238] tracking-wordmark text-ink on-flare:text-on-flare on-ink:text-on-ink"
        >
          gitflare
        </span>
      )}
    </span>
  );
}
