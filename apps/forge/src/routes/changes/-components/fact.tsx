import { cn } from "@gitflare/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * The UI package's `Row` (label, description, annotation under one hairline)
 * for a page that is read at any width: `Row` keeps its three fixed columns,
 * this one stacks them below `xl` and puts the annotation under the
 * description in between.
 */
export function Fact({
  label,
  annotation,
  className,
  children,
}: {
  label: ReactNode;
  /** The evidence: narrower and quieter, on the right when there is room. */
  annotation?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-s11 gap-y-s3 border-t border-rule pt-[22px] pb-[26px] md:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[var(--container-label)_minmax(0,1fr)_var(--container-annotation)]",
        className,
      )}
    >
      <div className="font-display text-body-m leading-body font-semibold text-ink">{label}</div>
      <div className="max-w-body min-w-0">{children}</div>
      {annotation != null && (
        <div className="min-w-0 text-faint md:col-start-2 xl:col-start-3 xl:text-right">
          {annotation}
        </div>
      )}
    </div>
  );
}
