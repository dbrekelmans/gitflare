import type { ComponentProps } from "react";
import { cx } from "../cx";

/**
 * Horizontal hairlines only. No vertical rules, no zebra, no outer border:
 * the columns are held by their lanes, not by a grid drawn around them.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      className={cx("w-full border-separate border-spacing-0 text-left", className)}
      {...props}
    />
  );
}

const alignments = { left: "text-left", right: "text-right" } as const;

type CellAlign = { align?: keyof typeof alignments };

export function Th({
  align = "left",
  className,
  ...props
}: Omit<ComponentProps<"th">, "align"> & CellAlign) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-rule pr-7 pb-4 font-display text-sm leading-ui font-medium text-muted last:pr-0",
        alignments[align],
        className,
      )}
      {...props}
    />
  );
}

export type TrProps = ComponentProps<"tr"> & { selected?: boolean };

export function Tr({ selected = false, className, ...props }: TrProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cx(selected && "bg-surface", className)}
      {...props}
    />
  );
}

/**
 * - `primary`: the column a person scans for, 15px medium ink.
 * - `text`: human columns, 14px muted.
 * - `machine`: counts, hashes, timestamps. Mono.
 */
export type TdKind = "primary" | "text" | "machine";

const cellKinds: Record<TdKind, string> = {
  primary: "type-ui",
  text: "type-meta font-regular",
  machine: "font-mono text-sm leading-ui tracking-mono",
};

const cellTones = {
  ink: "text-ink",
  muted: "text-muted",
  faint: "text-faint",
} as const;

export type TdProps = Omit<ComponentProps<"td">, "align"> &
  CellAlign & {
    kind?: TdKind;
    /** Defaults to ink for `primary`, muted otherwise. */
    tone?: keyof typeof cellTones;
  };

export function Td({
  kind = "text",
  tone = kind === "primary" ? "ink" : "muted",
  align = "left",
  className,
  ...props
}: TdProps) {
  return (
    <td
      className={cx(
        "border-b border-border py-5 pr-7 align-middle last:pr-0",
        cellKinds[kind],
        cellTones[tone],
        alignments[align],
        className,
      )}
      {...props}
    />
  );
}
