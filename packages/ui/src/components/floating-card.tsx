import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx";

/**
 * The single elevated surface of a view. Three bands inside one clipped
 * container, so the head hairline and the strip fill land flush against the
 * radius. This is where the system's one shadow lives: a view gets one
 * `FloatingCard`, and nothing else on it floats.
 */
export function FloatingCard({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cx(
        "flex w-full max-w-card flex-col overflow-clip rounded-card border-[1.5px] border-border bg-ground shadow-floating",
        className,
      )}
      {...props}
    />
  );
}

/** Head row: what this is on the left, its status on the right. */
export function FloatingCardHead({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      className={cx(
        "flex items-center justify-between gap-7 border-b border-border px-8 py-6",
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
      className={cx("flex flex-col gap-5 px-8 pt-8 pb-[26px]", className)}
      {...props}
    />
  );
}

/** A row of answers inside the body: buttons, then an unboxed recommendation. */
export function FloatingCardActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cx("flex flex-wrap items-center gap-3 pt-1", className)}
      {...props}
    />
  );
}

export type FloatingCardClaimsProps = Omit<ComponentProps<"footer">, "children"> & {
  /** The state the machine reports for the claims that follow, e.g. "verified". */
  label?: ReactNode;
  /** Right-aligned and muted: the escape hatch, available but not offered. */
  aside?: ReactNode;
  /** `Claim` elements. Stated, never boxed. */
  children?: ReactNode;
};

/** Footer claims strip: what was checked without you. */
export function FloatingCardClaims({
  label,
  aside,
  className,
  children,
  ...props
}: FloatingCardClaimsProps) {
  return (
    <footer
      className={cx(
        "flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border bg-surface px-8 py-5",
        className,
      )}
      {...props}
    >
      {label != null && (
        <span className="shrink-0 font-mono text-xs leading-xs font-medium tracking-status text-muted uppercase">
          {label}
        </span>
      )}
      {children}
      {aside != null && (
        <span className="type-meta grow text-right text-muted">{aside}</span>
      )}
    </footer>
  );
}

export function Claim({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cx("type-meta shrink-0 text-ink", className)}
      {...props}
    />
  );
}
