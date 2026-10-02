import type { ComponentProps, ReactNode } from "react";
import { cn } from "#lib/utils";

/**
 * The one elevated surface in page flow. Three bands inside one clipped
 * container, so the head hairline and the strip fill land flush against the
 * radius.
 *
 * A view gets at most one `FloatingCard`; nothing else in the page flow
 * carries a shadow. Transient overlays (popover, menu, dialog) are a
 * different layer and keep theirs. If a second thing on the page seems to
 * want a card, it wants a `Row` or a `SectionHead` instead.
 */
export function FloatingCard({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex w-full max-w-card flex-col overflow-clip rounded-card border-[1.5px] border-border bg-ground shadow-floating",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Head row: what this is on the left, its status on the right. The left
 * side gives way first: it truncates so the status never wraps.
 */
export function FloatingCardHead({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex items-center justify-between gap-s7 border-b border-border px-s8 py-s6 *:first:min-w-0 *:first:truncate *:last:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/** Body: the question, the reasoning, then the answers. */
export function FloatingCardBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-s5 px-s8 pt-s8 pb-[26px]", className)}
      {...props}
    />
  );
}

/**
 * A row of answers inside the body: buttons, then an unboxed recommendation.
 * The buttons keep their size; the recommendation takes what is left and
 * wraps inside it.
 */
export function FloatingCardActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-s3 pt-s1 *:data-[slot=button]:shrink-0 *:not-data-[slot=button]:min-w-0",
        className,
      )}
      {...props}
    />
  );
}

/** What the machine reports for the claims in the strip. */
export type ClaimsState = "verified" | "unverified" | "checks failed";

export type FloatingCardClaimsProps = Omit<ComponentProps<"footer">, "children"> & {
  /** Set in mono, because the machine is the one saying it. */
  state?: ClaimsState;
  /** Right-aligned and muted: the escape hatch, available but not offered. */
  aside?: ReactNode;
  /** `Claim` elements. Stated, never boxed. */
  children?: ReactNode;
};

/**
 * Footer claims strip: what was checked without you. The claims and the
 * escape hatch share one row. At the card's full width the claims sit on one
 * line and the aside wraps beside them; in a narrower column the claims wrap
 * too, rather than squeezing the aside into a sliver.
 */
export function FloatingCardClaims({
  state,
  aside,
  className,
  children,
  ...props
}: FloatingCardClaimsProps) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center gap-s6 border-t border-border bg-surface px-s8 py-s5 min-[880px]:flex-nowrap",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-s6 gap-y-s1">
        {state != null && (
          <span className="shrink-0 font-mono text-xs leading-xs font-medium tracking-status text-muted-foreground uppercase">
            {state}
          </span>
        )}
        {children}
      </div>
      {aside != null && (
        <span className="type-meta w-full text-right text-pretty text-muted-foreground min-[880px]:w-auto min-[880px]:min-w-[200px] min-[880px]:flex-1">
          {aside}
        </span>
      )}
    </footer>
  );
}

export function Claim({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("type-meta shrink-0 text-ink", className)}
      {...props}
    />
  );
}
