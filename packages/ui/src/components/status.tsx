import type { ComponentProps, ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { Badge, type badgeVariants } from "#components/ui/badge";
import { cn } from "#lib/utils";

/**
 * `flare` means "this is waiting on you". The three status tones are
 * semantic and are never used as a second accent. `neutral` is everything
 * that needs no attention.
 */
export type StatusTone = "flare" | "success" | "warning" | "danger" | "neutral";

const dotTones: Record<StatusTone, string> = {
  flare: "bg-flare",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-faint",
};

const dotSizes = {
  6: "size-[6px]",
  7: "size-[7px]",
  8: "size-[8px]",
} as const;

export type StatusDotProps = ComponentProps<"span"> & {
  tone?: StatusTone;
  size?: keyof typeof dotSizes;
};

export function StatusDot({
  tone = "flare",
  size = 6,
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-pill",
        dotSizes[size],
        dotTones[tone],
        className,
      )}
      {...props}
    />
  );
}

const badgeVariant: Record<
  StatusTone,
  NonNullable<VariantProps<typeof badgeVariants>["variant"]>
> = {
  flare: "default",
  success: "success",
  warning: "warning",
  danger: "destructive",
  neutral: "secondary",
};

export type StatusPillProps = Omit<ComponentProps<typeof Badge>, "variant"> & {
  tone?: StatusTone;
  /** Replaces the status dot, e.g. with a `StatusIcon`. Pass `null` for none. */
  mark?: ReactNode;
};

/** A status a person reads as a sentence: "1 question for you". */
export function StatusPill({
  tone = "flare",
  mark,
  children,
  ...props
}: StatusPillProps) {
  return (
    <Badge variant={badgeVariant[tone]} {...props}>
      {mark === undefined ? <StatusDot tone={tone} size={7} /> : mark}
      {children}
    </Badge>
  );
}

const tints: Record<StatusTone, string> = {
  // Mono at 11px on a tint needs the darkest orange to stay legible.
  flare: "bg-flare-tint text-flare-shade",
  success: "bg-success-tint text-success-deep",
  warning: "bg-warning-tint text-warning-deep",
  danger: "bg-danger-tint text-danger-deep",
  neutral: "bg-surface text-muted-foreground",
};

export type StatusBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  tone?: StatusTone;
  /** The state as the system reports it: "verified", "checks failed". */
  children: string;
};

/**
 * A state the machine reports about itself. Mono because the machine is the
 * author; it takes a string from the system, not copy. For a status phrased
 * for a person, use `StatusPill`.
 */
export function StatusBadge({
  tone = "success",
  className,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[28px] items-center gap-s2 rounded-pill px-s4 font-mono text-mono-xs leading-mono-xs tracking-status whitespace-nowrap uppercase",
        tints[tone],
        className,
      )}
      {...props}
    >
      <StatusDot tone={tone} size={8} />
      {children}
    </span>
  );
}

const chipTints: Record<Exclude<StatusTone, "neutral">, string> = {
  flare: "bg-flare-tint text-flare-deep",
  success: "bg-success-tint text-success-deep",
  warning: "bg-warning-tint text-warning-deep",
  danger: "bg-danger-tint text-danger-deep",
};

export type ChipProps = Omit<ComponentProps<"span">, "children"> & {
  tone?: Exclude<StatusTone, "neutral">;
  /** A machine-authored line: provenance, a trailer, a record id. */
  children: string;
};

/** An evidence chip: a machine-authored line set off on a tint. */
export function Chip({ tone = "flare", className, ...props }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-chip px-[18px] py-s4 font-mono text-meta leading-ui font-medium",
        chipTints[tone],
        className,
      )}
      {...props}
    />
  );
}

/**
 * - `done`: checked without you, and it held. Deliberately quiet.
 * - `failed`: did not hold, and did not block.
 * - `needs-you`: the one thing on the page that is waiting on a person.
 * - `open`: stated and left open rather than quietly dropped.
 */
export type StatusIconKind = "done" | "failed" | "needs-you" | "open";

export type StatusIconProps = Omit<ComponentProps<"svg">, "children"> & {
  kind: StatusIconKind;
  /** Read out when the icon is the only thing saying the status. */
  label?: string;
};

export function StatusIcon({
  kind,
  label,
  className,
  ...props
}: StatusIconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      {kind === "done" && (
        <>
          <circle cx="7" cy="7" r="6" className="fill-faint" />
          <path
            d="M4.5 7.2 L6.3 9 L9.6 5.3"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-ground"
          />
        </>
      )}
      {kind === "failed" && (
        <>
          <circle cx="7" cy="7" r="6" className="fill-faint" />
          <path
            d="M5.1 5.1 L8.9 8.9 M8.9 5.1 L5.1 8.9"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="stroke-ground"
          />
        </>
      )}
      {kind === "needs-you" && (
        <>
          <circle cx="7" cy="7" r="6" className="fill-flare" />
          <path
            d="M7 3.9 V7.5"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="stroke-on-flare"
          />
          <circle cx="7" cy="10" r="0.95" className="fill-on-flare" />
        </>
      )}
      {kind === "open" && (
        <circle
          cx="7"
          cy="7"
          r="5.25"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="1.5 2.62"
          className="stroke-flare"
        />
      )}
    </svg>
  );
}
