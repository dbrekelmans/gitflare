import type { ComponentProps } from "react";
import { cx } from "../cx";

/**
 * The hero field: the one place flare is a surface. Inside it neutrals are
 * replaced by white at alpha, and the primitives restyle themselves to
 * match. Nothing on this field is set in ink.
 */
export function FlareField({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx("on-flare rounded-card bg-flare-field text-on-flare", className)}
      {...props}
    />
  );
}
