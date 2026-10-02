import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx";
import { ChevronDown } from "./form";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
};

export type SegmentedProps<T extends string> = Omit<
  ComponentProps<"div">,
  "onChange" | "children"
> & {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
};

/**
 * Segments share one outline and one hairline between them. The selected
 * segment is ink, not flare: a group is a view filter, not an action.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className,
  ...props
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cx(
        "inline-flex overflow-clip rounded-pill border-[1.5px]",
        disabled ? "border-border-disabled" : "border-border",
        className,
      )}
      {...props}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange?.(option.value)}
          className="type-ui cursor-pointer border-l border-border px-7 py-[11px] text-ink outline-none transition-colors duration-150 first:border-l-0 hover:bg-surface focus-visible:bg-surface active:bg-press aria-checked:bg-ink aria-checked:text-on-ink aria-checked:hover:bg-ink aria-checked:active:bg-ink disabled:cursor-not-allowed disabled:border-border-disabled disabled:bg-transparent disabled:text-faint disabled:aria-checked:bg-surface disabled:aria-checked:text-faint"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type SplitButtonProps = Omit<ComponentProps<"div">, "onClick"> & {
  /** `flare` is an action with more behind a caret; `outline` carries a count. */
  variant?: "flare" | "outline";
  onClick?: () => void;
  /** What sits in the second part. Defaults to a caret. */
  trailing?: ReactNode;
  /** Names the second part for assistive tech when it is a caret. */
  trailingLabel?: string;
  onTrailingClick?: () => void;
  disabled?: boolean;
};

const splitParts = {
  flare: {
    group: "",
    main: "bg-flare px-7 text-on-flare hover:bg-flare-deep active:bg-flare-shade disabled:bg-surface disabled:text-faint",
    trailing:
      "border-l border-on-flare-border bg-flare px-[14px] text-on-flare hover:bg-flare-deep active:bg-flare-shade disabled:border-border disabled:bg-surface disabled:text-faint",
  },
  outline: {
    group: "border-[1.5px] border-border has-disabled:border-border-disabled",
    main: "px-5 text-ink hover:bg-surface active:bg-press disabled:bg-transparent disabled:text-faint",
    trailing:
      "border-l border-border px-5 font-mono text-sm font-regular tracking-mono text-muted hover:bg-surface active:bg-press disabled:border-border-disabled disabled:bg-transparent disabled:text-faint",
  },
} as const;

/** Two parts under one outline. State lands on one part; disabled takes both. */
export function SplitButton({
  variant = "flare",
  onClick,
  trailing,
  trailingLabel = "More options",
  onTrailingClick,
  disabled = false,
  className,
  children,
  ...props
}: SplitButtonProps) {
  const parts = splitParts[variant];
  const part =
    "type-ui flex cursor-pointer items-center py-[11px] outline-none transition-colors duration-150 focus-visible:underline disabled:cursor-not-allowed";
  return (
    <div
      className={cx("inline-flex overflow-clip rounded-pill", parts.group, className)}
      {...props}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cx(part, parts.main)}
      >
        {children}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onTrailingClick}
        aria-label={trailing == null ? trailingLabel : undefined}
        className={cx(part, parts.trailing)}
      >
        {trailing ?? <ChevronDown className="stroke-current" />}
      </button>
    </div>
  );
}
