import type { ReactNode } from "react";
import { cx, Evidence, Heading, Text } from "../src";

/** A section opener: the statement on the left, what backs it on the right. */
export function Statement({
  title,
  children,
  pad = "pb-10",
}: {
  title: ReactNode;
  children: ReactNode;
  pad?: "pb-10" | "pb-[40px]" | "pb-[36px]";
}) {
  return (
    <div className={cx("flex items-end gap-17 border-t border-rule pt-9", pad)}>
      <Heading level={2} size="display-s" className="w-claim shrink-0">
        {title}
      </Heading>
      <Text size="body-m" tone="muted" className="w-support shrink-0">
        {children}
      </Text>
    </div>
  );
}

/** A primitive's sheet: its name, what it is for, then lanes of examples. */
export function Sheet({
  title,
  children,
  lede,
}: {
  title: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="px-13 pt-13 pb-10">
      <div className="flex items-end gap-17 pb-[36px]">
        <Heading level={3} size="display-s" className="w-claim shrink-0">
          {title}
        </Heading>
        <Text tone="muted" className="w-support shrink-0">
          {lede}
        </Text>
      </div>
      {children}
    </section>
  );
}

export function Lane({
  label,
  note,
  center = false,
  children,
}: {
  label: string;
  note?: ReactNode;
  center?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex gap-11 pb-10", center ? "items-center" : "items-start")}>
      <Text size="sm" tone="muted" className="w-lane shrink-0">
        {label}
      </Text>
      <div className="min-w-0 flex-1">{children}</div>
      {note != null && <Note className="w-annotation shrink-0">{note}</Note>}
    </div>
  );
}

/** A measurement, read off the theme or the primitive. */
export function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Evidence
      as="div"
      kind="note"
      size="xs"
      className={cx("leading-mono whitespace-pre-line", className)}
    >
      {children}
    </Evidence>
  );
}
