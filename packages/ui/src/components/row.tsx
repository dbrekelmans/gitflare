import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { EvidenceProps } from "#components/typography";
import { cn } from "#lib/utils";

export type RowProps = Omit<ComponentProps<"div">, "children"> & {
  /** The claim, on the left. */
  label: ReactNode;
  /**
   * The right column: narrower and quieter than the description. It takes
   * an `Evidence` element when a machine authored it (a measurement, a
   * count, a hash) and plain text when a person did. The row does not set
   * mono on its own.
   */
  annotation?: ReactElement<EvidenceProps> | string;
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
      className={cn(
        "flex items-start gap-s11",
        inverse
          ? "on-ink bg-ink px-[36px] pt-[32px] pb-s9"
          : "border-t border-rule pt-[22px] pb-[26px]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "shrink-0 font-display text-body-m leading-body font-semibold",
          inverse ? "w-[224px] text-flare" : "w-label text-ink",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "type-body max-w-body min-w-0 flex-1",
          inverse ? "text-on-ink" : "text-muted-foreground",
        )}
      >
        {children}
      </div>
      {annotation != null && (
        <div
          className={cn(
            "type-detail ml-auto w-annotation shrink-0 text-right leading-body",
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
      className={cn(
        "flex items-baseline justify-between gap-s7 border-t border-rule pt-[28px] pb-s6",
        className,
      )}
      {...props}
    >
      <Tag className="type-title text-ink">{title}</Tag>
      {aside != null && (
        <div className="type-meta font-regular text-muted-foreground">{aside}</div>
      )}
    </div>
  );
}
