import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cx } from "../cx";
import { StatusDot } from "./status";

export type LabelProps = ComponentProps<"label"> & {
  /**
   * The machine-facing half of the label: "required", "optional", a format.
   * Requirement is stated in words, not marked with an asterisk.
   */
  hint?: ReactNode;
};

export function Label({ hint, className, children, ...props }: LabelProps) {
  return (
    <div className="flex items-baseline justify-between gap-7">
      <label
        className={cx(
          "font-display text-sm leading-ui font-medium text-ink",
          className,
        )}
        {...props}
      >
        {children}
      </label>
      {hint != null && <span className="type-mono-xs text-faint">{hint}</span>}
    </div>
  );
}

export function HelpText({ className, ...props }: ComponentProps<"p">) {
  return <p className={cx("type-sm text-muted", className)} {...props} />;
}

/**
 * The only place flare enters a control. It reads as a status dot, which the
 * system already permits, not as decoration.
 */
export function ErrorText({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cx("type-sm flex items-center gap-2 text-flare-deep", className)}
      {...props}
    >
      <StatusDot tone="flare" size={6} />
      {children}
    </p>
  );
}

// Focus thickens the rule to 1.5px ink rather than adding a glow; the
// padding gives back the half pixel so the text does not move.
const underline =
  "w-full border-b border-rule bg-transparent font-display text-body leading-body-s text-ink outline-none placeholder:text-faint focus:border-b-[1.5px] focus:border-ink disabled:text-faint aria-invalid:border-b-[1.5px] aria-invalid:border-flare-deep";
const underlinePad = "pb-[11px] focus:pb-[10.5px] aria-invalid:pb-[10.5px]";

export type InputProps = ComponentProps<"input"> & {
  /**
   * `underline` is a rule you type on. `framed` exists only inside overlays
   * and table filters, where there is no page ground to sit on.
   */
  variant?: "underline" | "framed";
  /** Framed only: an icon before the text. */
  leading?: ReactNode;
};

export function Input({
  variant = "underline",
  leading,
  className,
  ...props
}: InputProps) {
  if (variant === "framed") {
    return (
      <span
        className={cx(
          "flex w-full items-center gap-3 rounded-chip border-[1.5px] border-border px-[14px] py-[11px] focus-within:border-ink has-aria-invalid:border-flare-deep",
          className,
        )}
      >
        {leading}
        <input
          className="min-w-0 grow bg-transparent font-display text-ui leading-body-s text-ink outline-none placeholder:text-faint"
          {...props}
        />
      </span>
    );
  }
  return <input className={cx(underline, underlinePad, className)} {...props} />;
}

/** Grows to its content; the rule stays at the last line. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={1}
      className={cx(
        underline,
        "block field-sizing-content resize-none pt-[2px] pb-4 focus:pb-[11.5px] aria-invalid:pb-[11.5px]",
        className,
      )}
      {...props}
    />
  );
}

export function SearchIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="round"
      {...props}
      className={cx("shrink-0 stroke-faint", props.className)}
    >
      <circle cx="6" cy="6" r="4.75" />
      <path d="M9.5 9.5 L13 13" />
    </svg>
  );
}

type ChoiceProps = Omit<ComponentProps<"input">, "type" | "children"> & {
  /** The label. Omit it only when the control labels itself another way. */
  children?: ReactNode;
  /** A second, muted line under the label. */
  description?: ReactNode;
};

const choiceBox =
  "peer col-start-1 row-start-1 size-(--container-control) cursor-pointer appearance-none border-[1.5px] border-border outline-offset-2 outline-ink checked:border-ink checked:bg-ink indeterminate:border-ink indeterminate:bg-ink focus-visible:outline-[1.5px] disabled:cursor-not-allowed disabled:border-rule disabled:bg-surface";

function ChoiceLabel({
  control,
  description,
  className,
  children,
}: {
  control: ReactNode;
  description?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  if (children == null && description == null) return control;
  return (
    <label
      className={cx(
        "group flex cursor-pointer items-start gap-4 has-disabled:cursor-not-allowed",
        className,
      )}
    >
      <span className="mt-[2px] flex shrink-0">{control}</span>
      <span className="flex flex-col gap-[2px]">
        <span className="type-body-s text-ink group-has-disabled:text-faint">
          {children}
        </span>
        {description != null && (
          <span className="type-sm text-muted">{description}</span>
        )}
      </span>
    </label>
  );
}

export type CheckboxProps = ChoiceProps & {
  /** Mixed: some, not all. */
  indeterminate?: boolean;
};

/**
 * Many out of many. It marks in ink: a checkbox almost always arrives inside
 * a list, where flare would shout.
 */
export function Checkbox({
  indeterminate = false,
  description,
  className,
  children,
  ...props
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const control = (
    <span className="inline-grid shrink-0 place-items-center">
      <input
        ref={ref}
        type="checkbox"
        className={cx(choiceBox, "rounded-control")}
        {...props}
      />
      <svg
        width="11"
        height="8"
        viewBox="0 0 11 8"
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 hidden stroke-on-ink peer-checked:block peer-indeterminate:hidden"
      >
        <path
          d="M1 4 L4 6.8 L10 1"
          fill="none"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 hidden h-[1.75px] w-2 rounded-pill bg-on-ink peer-indeterminate:block"
      />
    </span>
  );
  return (
    <ChoiceLabel control={control} description={description} className={className}>
      {children}
    </ChoiceLabel>
  );
}

/** One out of many. The same box taken to a full circle. */
export function Radio({ description, className, children, ...props }: ChoiceProps) {
  const control = (
    <span className="inline-grid shrink-0 place-items-center">
      <input type="radio" className={cx(choiceBox, "rounded-pill")} {...props} />
      <span
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 hidden size-[6px] rounded-pill bg-on-ink peer-checked:block"
      />
    </span>
  );
  return (
    <ChoiceLabel control={control} description={description} className={className}>
      {children}
    </ChoiceLabel>
  );
}

export type SwitchProps = Omit<ComponentProps<"input">, "type" | "children"> & {
  children?: ReactNode;
};

/**
 * On or off, applied the moment you touch it. The one control that takes
 * flare, because it reports something live. Label left, switch right.
 */
export function Switch({ className, children, ...props }: SwitchProps) {
  const control = (
    <input
      type="checkbox"
      role="switch"
      className="relative h-[26px] w-[44px] shrink-0 cursor-pointer appearance-none rounded-pill bg-rule outline-offset-2 outline-ink transition-colors duration-150 before:absolute before:top-[3px] before:left-[3px] before:size-[20px] before:rounded-pill before:bg-ground before:transition-transform before:duration-150 checked:bg-flare checked:before:translate-x-[18px] focus-visible:outline-[1.5px] disabled:cursor-not-allowed disabled:bg-surface motion-reduce:transition-none motion-reduce:before:transition-none"
      {...props}
    />
  );
  if (children == null) return control;
  return (
    <label
      className={cx(
        "group flex cursor-pointer items-center justify-between gap-7 has-disabled:cursor-not-allowed",
        className,
      )}
    >
      <span className="type-body-s text-ink group-has-disabled:text-faint">
        {children}
      </span>
      {control}
    </label>
  );
}

export function ChevronDown(props: ComponentProps<"svg">) {
  return (
    <svg
      width="12"
      height="8"
      viewBox="0 0 12 8"
      aria-hidden="true"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      className={cx("shrink-0", props.className)}
    >
      <path d="M1 1.5 L6 6.5 L11 1.5" />
    </svg>
  );
}

export type SelectProps = ComponentProps<"select"> & {
  /** Shown faint while nothing is chosen. Rendered as an empty-value option. */
  placeholder?: string;
};

/**
 * Closed, a select is an input with a chevron. Open, it is the platform's
 * own picker; a custom list is a `Menu` inside a `Popover`.
 */
export function Select({ placeholder, className, children, ...props }: SelectProps) {
  return (
    <span className={cx("relative block w-full", className)}>
      <select
        className={cx(
          underline,
          underlinePad,
          "peer cursor-pointer appearance-none pr-[28px] has-[option[value='']:checked]:text-faint",
        )}
        {...props}
      >
        {placeholder != null && <option value="">{placeholder}</option>}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-[8px] right-0 stroke-muted peer-has-[option[value='']:checked]:stroke-faint" />
    </span>
  );
}
