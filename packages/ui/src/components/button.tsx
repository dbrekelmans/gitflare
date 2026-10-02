import type { ComponentProps } from "react";
import { cx } from "../cx";

export type StatusTone = "success" | "warning" | "danger";

/**
 * - `flare`: a moment the system is waiting on. A dialog, a question, an
 *   inline decision. Never more than one on screen.
 * - `ink`: a standing action that is always available, like the one in the nav.
 * - a status tone: one per view, and never on a flare field.
 */
export type ButtonTone = "ink" | "flare" | StatusTone;

export type ButtonSize = "lg" | "md" | "sm";

type Variant =
  | { variant?: "primary"; tone?: ButtonTone }
  | { variant: "secondary" | "ghost"; tone?: "ink" | StatusTone };

type Shared = Variant & { size?: ButtonSize };

export type ButtonProps =
  | (Shared & ComponentProps<"button"> & { href?: undefined })
  | (Shared & ComponentProps<"a"> & { href: string });

const base =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-pill font-display font-medium whitespace-nowrap transition-colors duration-150 select-none outline-offset-2 outline-ink focus-visible:outline-[1.5px] disabled:cursor-not-allowed on-flare:outline-on-flare";

const sizes: Record<ButtonSize, string> = {
  lg: "px-8 py-[14px] text-body-m leading-ui",
  md: "px-7 py-[11px] text-ui leading-ui",
  sm: "px-5 py-[7px] text-sm leading-xs",
};

const disabledFill =
  "disabled:bg-surface disabled:text-faint on-flare:disabled:bg-on-flare-fill on-flare:disabled:text-on-flare-muted";

const primary: Record<ButtonTone, string> = {
  // On a flare field the flare primary cannot read as an action; white takes the moment.
  flare: cx(
    "bg-flare text-on-flare hover:bg-flare-deep active:bg-flare-shade",
    "on-flare:bg-on-flare on-flare:text-ink on-flare:hover:bg-flare-tint on-flare:active:bg-on-flare-press on-flare:active:text-flare-shade",
    disabledFill,
  ),
  ink: cx(
    "bg-ink text-on-ink hover:bg-ink-hover active:bg-ink-press",
    disabledFill,
  ),
  success: cx(
    "bg-success text-on-success hover:bg-success-deep active:bg-success-press",
    disabledFill,
  ),
  warning: cx(
    "bg-warning text-on-warning hover:bg-warning-deep active:bg-warning-press",
    disabledFill,
  ),
  danger: cx(
    "bg-danger text-on-danger hover:bg-danger-deep active:bg-danger-press",
    disabledFill,
  ),
};

const secondaryDisabled =
  "disabled:border-border-disabled disabled:bg-transparent disabled:text-faint";

const secondary: Record<"ink" | StatusTone, string> = {
  ink: cx(
    "border-[1.5px] border-border bg-ground text-ink hover:border-rule hover:bg-surface active:border-border-press active:bg-press",
    "on-flare:border-on-flare-border on-flare:bg-transparent on-flare:text-on-flare on-flare:hover:border-on-flare-border-hover on-flare:hover:bg-on-flare-fill on-flare:active:border-on-flare-border-hover on-flare:active:bg-on-flare-fill-press",
    secondaryDisabled,
    "on-flare:disabled:border-on-flare-fill-press on-flare:disabled:bg-transparent on-flare:disabled:text-on-flare-muted",
  ),
  success: cx(
    "border-[1.5px] border-success/35 text-success-deep hover:border-success/54 hover:bg-success-tint active:border-success active:bg-success-tint-press",
    secondaryDisabled,
  ),
  warning: cx(
    "border-[1.5px] border-warning/35 text-warning-deep hover:border-warning/54 hover:bg-warning-tint active:border-warning active:bg-warning-tint-press",
    secondaryDisabled,
  ),
  danger: cx(
    "border-[1.5px] border-danger/35 text-danger-deep hover:border-danger/54 hover:bg-danger-tint active:border-danger active:bg-danger-tint-press",
    secondaryDisabled,
  ),
};

const ghostDisabled = "disabled:bg-transparent disabled:text-faint";

const ghost: Record<"ink" | StatusTone, string> = {
  ink: cx(
    "text-ink hover:bg-surface active:bg-press",
    "on-flare:text-on-flare on-flare:hover:bg-on-flare-fill on-flare:active:bg-on-flare-fill-press",
    ghostDisabled,
    "on-flare:disabled:bg-transparent on-flare:disabled:text-on-flare-muted",
  ),
  success: cx(
    "text-success-deep hover:bg-success-tint active:bg-success-tint-press",
    ghostDisabled,
  ),
  warning: cx(
    "text-warning-deep hover:bg-warning-tint active:bg-warning-tint-press",
    ghostDisabled,
  ),
  danger: cx(
    "text-danger-deep hover:bg-danger-tint active:bg-danger-tint-press",
    ghostDisabled,
  ),
};

function variantClass(props: Variant): string {
  switch (props.variant) {
    case "secondary":
      return secondary[props.tone ?? "ink"];
    case "ghost":
      return ghost[props.tone ?? "ink"];
    default:
      return primary[props.tone ?? "ink"];
  }
}

export function Button(props: ButtonProps) {
  const { variant, tone, size = "md", className, ...rest } = props;
  const classes = cx(
    base,
    sizes[size],
    variantClass({ variant, tone } as Variant),
    className,
  );

  if (rest.href !== undefined) {
    return <a className={classes} {...rest} />;
  }
  return <button type="button" className={classes} {...rest} />;
}
