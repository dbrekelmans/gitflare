import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx";

export type RowProps = Omit<ComponentProps<"div">, "children"> & {
  /** The claim, on the left. */
  label: ReactNode;
  /** The evidence, on the right: narrower, quieter, machine-authored. */
  annotation?: ReactNode;
  /**
   * `inverse` is Gitflare's own row: ink fill, no border and no radius, and
   * the one place flare is used as a name. One per view.
   */
  tone?: "default" | "inverse";
  /** The description, in the middle. */
  children?: ReactNode;
};

/**
 * Label, description, annotation. No border and no fill: the hairline above
 * is the only structure, so a list of rows needs no divider element.
 */
export function Row({
  label,
  annotation,
  tone = "default",
  className,
  children,
  ...props
}: RowProps) {
  const inverse = tone === "inverse";
  return (
    <div
      className={cx(
        "flex items-start gap-11",
        inverse
          ? "on-ink bg-ink px-[36px] pt-[32px] pb-9"
          : "border-t border-rule pt-[22px] pb-[26px]",
        className,
      )}
      {...props}
    >
      <div
        className={cx(
          "shrink-0 font-display text-body-m leading-body font-semibold",
          inverse ? "w-[224px] text-flare" : "w-label text-ink",
        )}
      >
        {label}
      </div>
      <div
        className={cx(
          "type-body max-w-body min-w-0 flex-1",
          inverse ? "text-on-ink" : "text-muted",
        )}
      >
        {children}
      </div>
      {annotation != null && (
        <div
          className={cx(
            "ml-auto w-annotation shrink-0 text-right font-mono text-xs leading-body",
            inverse ? "text-faint-inverse" : "text-faint",
          )}
        >
          {annotation}
        </div>
      )}
    </div>
  );
}

export type SectionHeadProps = Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  /** Right-aligned and quiet: a count, a summary, a qualifier. */
  aside?: ReactNode;
  level?: 2 | 3 | 4;
};

/** Opens a section of a page: a hairline, a title, and what backs it. */
export function SectionHead({
  title,
  aside,
  level = 2,
  className,
  ...props
}: SectionHeadProps) {
  const Tag = `h${level}` as const;
  return (
    <div
      className={cx(
        "flex items-baseline justify-between gap-7 border-t border-rule pt-[28px] pb-6",
        className,
      )}
      {...props}
    >
      <Tag className="type-title text-ink">{title}</Tag>
      {aside != null && (
        <div className="type-meta font-regular text-muted">{aside}</div>
      )}
    </div>
  );
}
